package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	capCore = "urn:ietf:params:jmap:core"
	capMail = "urn:ietf:params:jmap:mail"

	queryPage = 250 // server maxQueryLimit
	getChunk  = 200 // server maxObjectsInGet
	setChunk  = 100 // server maxObjectsInSet
)

// ErrAuth means the JMAP server rejected the credentials.
var ErrAuth = errors.New("authentication failed")

// Client talks to a Mailflare JMAP server.
type Client struct {
	base *url.URL
	http *http.Client
}

// NewClient builds a client for the JMAP origin (e.g. https://mail.example.com).
func NewClient(baseURL string) (*Client, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, fmt.Errorf("invalid jmap_url %q", baseURL)
	}
	tr := &http.Transport{
		Proxy:                 nil,
		ResponseHeaderTimeout: 30 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       60 * time.Second,
	}
	// Never follow redirects: the key must only go to the configured origin.
	hc := &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	return &Client{base: u, http: hc}, nil
}

// Account is an authenticated JMAP account (a Session plus the key).
type Account struct {
	c           *Client
	key         string
	AccountID   string
	Username    string
	apiURL      string
	downloadURL string
}

type sessionDoc struct {
	Username        string            `json:"username"`
	APIURL          string            `json:"apiUrl"`
	DownloadURL     string            `json:"downloadUrl"`
	PrimaryAccounts map[string]string `json:"primaryAccounts"`
}

func (c *Client) newReq(ctx context.Context, method, u, key string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("User-Agent", "mailflare-pop3")
	return req, nil
}

// sameOrigin refuses server-provided URLs that point to another host, so the
// key can never be sent anywhere but the configured JMAP origin.
func (c *Client) sameOrigin(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host != c.base.Host || u.Scheme != c.base.Scheme {
		return fmt.Errorf("session URL %q is not on the configured jmap_url origin", raw)
	}
	return nil
}

// Login fetches the JMAP session with the app password; success means valid.
func (c *Client) Login(ctx context.Context, key string) (*Account, error) {
	req, err := c.newReq(ctx, http.MethodGet, c.base.String()+"/jmap/session", key, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, ErrAuth
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("session: HTTP %d", resp.StatusCode)
	}
	var s sessionDoc
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&s); err != nil {
		return nil, fmt.Errorf("session: %w", err)
	}
	id := s.PrimaryAccounts[capMail]
	if id == "" || s.APIURL == "" || s.DownloadURL == "" {
		return nil, errors.New("session: missing account or URLs")
	}
	if err := c.sameOrigin(s.APIURL); err != nil {
		return nil, err
	}
	if err := c.sameOrigin(s.DownloadURL); err != nil {
		return nil, err
	}
	return &Account{c: c, key: key, AccountID: id, Username: s.Username, apiURL: s.APIURL, downloadURL: s.DownloadURL}, nil
}

type methodResp struct {
	Name string
	Args json.RawMessage
}

// call issues one JMAP request and returns the method responses in order.
func (a *Account) call(ctx context.Context, calls ...[]any) ([]methodResp, error) {
	payload := map[string]any{"using": []string{capCore, capMail}, "methodCalls": calls}
	b, _ := json.Marshal(payload)
	req, err := a.c.newReq(ctx, http.MethodPost, a.apiURL, a.key, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jmap api: HTTP %d", resp.StatusCode)
	}
	var doc struct {
		MethodResponses [][3]json.RawMessage `json:"methodResponses"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&doc); err != nil {
		return nil, fmt.Errorf("jmap api: %w", err)
	}
	out := make([]methodResp, 0, len(doc.MethodResponses))
	for _, m := range doc.MethodResponses {
		var name string
		_ = json.Unmarshal(m[0], &name)
		if name == "error" {
			return nil, fmt.Errorf("jmap error: %s", string(m[1]))
		}
		out = append(out, methodResp{Name: name, Args: m[1]})
	}
	if len(out) != len(calls) {
		return nil, errors.New("jmap api: unexpected response count")
	}
	return out, nil
}

// Message is one maildrop entry.
type Message struct {
	ID      string
	BlobID  string
	Size    int64
	TrashID string // JMAP mailbox id to move to on delete ("" if unknown)
	InboxID string
}

type mailbox struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	ParentID *string `json:"parentId"`
	Role     *string `json:"role"`
}

var blobIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

var addrRe = regexp.MustCompile(`<([^<>]+)>\s*$`)

func mailboxAddress(name string) string {
	if m := addrRe.FindStringSubmatch(name); m != nil {
		return strings.ToLower(strings.TrimSpace(m[1]))
	}
	return strings.ToLower(strings.TrimSpace(name))
}

// Maildrop snapshots the inbox messages for user. If user matches the address
// of one Mailflare mailbox only its inbox is used, otherwise all inboxes.
func (a *Account) Maildrop(ctx context.Context, user string, maxMessages int) ([]Message, error) {
	res, err := a.call(ctx, []any{"Mailbox/get", map[string]any{
		"accountId": a.AccountID, "ids": nil, "properties": []string{"id", "name", "parentId", "role"},
	}, "m"})
	if err != nil {
		return nil, err
	}
	var mg struct {
		List []mailbox `json:"list"`
	}
	if err := json.Unmarshal(res[0].Args, &mg); err != nil {
		return nil, err
	}
	type pair struct{ inbox, trash string }
	pairs := map[string]*pair{} // top-level mailbox id -> inbox/trash
	var order []string
	addr := map[string]string{}
	for _, m := range mg.List {
		if m.ParentID == nil {
			pairs[m.ID] = &pair{}
			order = append(order, m.ID)
			addr[m.ID] = mailboxAddress(m.Name)
		}
	}
	for _, m := range mg.List {
		if m.ParentID == nil || m.Role == nil {
			continue
		}
		p := pairs[*m.ParentID]
		if p == nil {
			continue
		}
		switch *m.Role {
		case "inbox":
			p.inbox = m.ID
		case "trash":
			p.trash = m.ID
		}
	}
	want := strings.ToLower(strings.TrimSpace(user))
	selected := order
	for _, id := range order {
		if want != "" && addr[id] == want {
			selected = []string{id}
			break
		}
	}
	var msgs []Message
	for _, id := range selected {
		p := pairs[id]
		if p.inbox == "" {
			continue
		}
		part, err := a.inboxMessages(ctx, p.inbox, p.trash, maxMessages)
		if err != nil {
			return nil, err
		}
		msgs = append(msgs, part...)
	}
	if maxMessages > 0 && len(msgs) > maxMessages {
		msgs = msgs[len(msgs)-maxMessages:] // newest N
	}
	return msgs, nil
}

func (a *Account) inboxMessages(ctx context.Context, inbox, trash string, maxMessages int) ([]Message, error) {
	var ids []string
	for pos := 0; ; pos += queryPage {
		res, err := a.call(ctx, []any{"Email/query", map[string]any{
			"accountId": a.AccountID,
			"filter":    map[string]any{"inMailbox": inbox},
			"sort":      []map[string]any{{"property": "receivedAt", "isAscending": true}},
			"position":  pos, "limit": queryPage,
		}, "q"})
		if err != nil {
			return nil, err
		}
		var q struct {
			IDs []string `json:"ids"`
		}
		if err := json.Unmarshal(res[0].Args, &q); err != nil {
			return nil, err
		}
		if len(q.IDs) > queryPage {
			return nil, errors.New("jmap: page larger than requested limit")
		}
		ids = append(ids, q.IDs...)
		if len(q.IDs) < queryPage {
			break
		}
		if maxMessages > 0 && len(ids) > 20*maxMessages+queryPage { // runaway guard
			return nil, errors.New("jmap: mailbox too large")
		}
	}
	if maxMessages > 0 && len(ids) > maxMessages {
		ids = ids[len(ids)-maxMessages:] // oldest-first order, keep the newest N
	}
	var out []Message
	for i := 0; i < len(ids); i += getChunk {
		end := min(i+getChunk, len(ids))
		res, err := a.call(ctx, []any{"Email/get", map[string]any{
			"accountId": a.AccountID, "ids": ids[i:end], "properties": []string{"id", "blobId", "size"},
		}, "g"})
		if err != nil {
			return nil, err
		}
		var g struct {
			List []struct {
				ID     string `json:"id"`
				BlobID string `json:"blobId"`
				Size   int64  `json:"size"`
			} `json:"list"`
		}
		if err := json.Unmarshal(res[0].Args, &g); err != nil {
			return nil, err
		}
		byID := map[string]int{}
		for k, e := range g.List {
			byID[e.ID] = k
		}
		for _, id := range ids[i:end] { // keep query order
			if k, ok := byID[id]; ok {
				e := g.List[k]
				out = append(out, Message{ID: e.ID, BlobID: e.BlobID, Size: e.Size, TrashID: trash, InboxID: inbox})
			}
		}
	}
	return out, nil
}

// Download opens the raw RFC 5322 blob. The caller must close the reader.
func (a *Account) Download(ctx context.Context, blobID string) (io.ReadCloser, error) {
	if !blobIDRe.MatchString(blobID) {
		return nil, errors.New("invalid blob id")
	}
	u := strings.NewReplacer(
		"{accountId}", url.PathEscape(a.AccountID),
		"{blobId}", url.PathEscape(blobID),
		"{name}", "message.eml",
		"{type}", url.QueryEscape("message/rfc822"),
	).Replace(a.downloadURL)
	req, err := a.c.newReq(ctx, http.MethodGet, u, a.key, nil)
	if err != nil {
		return nil, err
	}
	resp, err := a.c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("download: HTTP %d", resp.StatusCode)
	}
	return resp.Body, nil
}

// MoveToTrash moves each message into its mailbox's trash. It never destroys.
// It returns the number moved and an error if any move failed.
func (a *Account) MoveToTrash(ctx context.Context, msgs []Message) (int, error) {
	moved := 0
	var firstErr error
	for i := 0; i < len(msgs); i += setChunk {
		end := min(i+setChunk, len(msgs))
		upd := map[string]any{}
		for _, m := range msgs[i:end] {
			if m.TrashID == "" {
				if firstErr == nil {
					firstErr = fmt.Errorf("no trash mailbox for %s", m.ID)
				}
				continue
			}
			upd[m.ID] = map[string]any{"mailboxIds": map[string]bool{m.TrashID: true}}
		}
		if len(upd) == 0 {
			continue
		}
		res, err := a.call(ctx, []any{"Email/set", map[string]any{"accountId": a.AccountID, "update": upd}, "s"})
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		var s struct {
			Updated    map[string]json.RawMessage `json:"updated"`
			NotUpdated map[string]json.RawMessage `json:"notUpdated"`
		}
		if err := json.Unmarshal(res[0].Args, &s); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		moved += len(upd) - len(s.NotUpdated)
		if len(s.NotUpdated) > 0 && firstErr == nil {
			firstErr = fmt.Errorf("%d messages not moved", len(s.NotUpdated))
		}
	}
	return moved, firstErr
}
