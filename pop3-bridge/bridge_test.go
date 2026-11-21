package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

const goodKey = "good-app-password"

type fakeMsg struct {
	id, mailbox, raw string
}

type fakeJMAP struct {
	t           *testing.T
	srv         *httptest.Server
	mu          sync.Mutex
	msgs        []fakeMsg
	moved       map[string]string // email id -> new mailbox id
	sessHit     int
	ignoreLimit bool
}

func newFakeJMAP(t *testing.T) *fakeJMAP {
	f := &fakeJMAP{t: t, moved: map[string]string{}}
	f.msgs = []fakeMsg{
		{"e1", "inbox-a", "Subject: one\r\n\r\nhello\r\n.dot line\r\nbye\r\n"},
		{"e2", "inbox-a", "Subject: two\nFrom: x@y.z\n\nline1\nline2\nline3\n"}, // bare LF
		{"e3", "inbox-b", "Subject: three\r\n\r\nother mailbox\r\n"},
	}
	mux := http.NewServeMux()
	auth := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") != "Bearer "+goodKey {
			w.WriteHeader(401)
			return false
		}
		return true
	}
	mux.HandleFunc("/jmap/session", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		f.mu.Lock()
		f.sessHit++
		f.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{
			"username": "a@x.test", "apiUrl": f.srv.URL + "/jmap/api",
			"downloadUrl":     f.srv.URL + "/jmap/download/{accountId}/{blobId}/{name}?type={type}",
			"primaryAccounts": map[string]string{capMail: "acc1"},
		})
	})
	mux.HandleFunc("/jmap/api", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		var req struct {
			MethodCalls [][3]json.RawMessage `json:"methodCalls"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		var out [][]any
		for _, c := range req.MethodCalls {
			var name string
			json.Unmarshal(c[0], &name)
			var args map[string]json.RawMessage
			json.Unmarshal(c[1], &args)
			out = append(out, []any{name, f.method(name, args), "x"})
		}
		json.NewEncoder(w).Encode(map[string]any{"methodResponses": out})
	})
	mux.HandleFunc("/jmap/download/", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		parts := strings.Split(r.URL.Path, "/")
		blob := parts[4]
		for _, m := range f.msgs {
			if "blob-"+m.id == blob {
				io.WriteString(w, m.raw)
				return
			}
		}
		w.WriteHeader(404)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeJMAP) method(name string, args map[string]json.RawMessage) any {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch name {
	case "Mailbox/get":
		return map[string]any{"list": []map[string]any{
			{"id": "acct-a", "name": "Alice <a@x.test>", "parentId": nil, "role": nil},
			{"id": "inbox-a", "name": "Inbox", "parentId": "acct-a", "role": "inbox"},
			{"id": "trash-a", "name": "Trash", "parentId": "acct-a", "role": "trash"},
			{"id": "acct-b", "name": "b@x.test", "parentId": nil, "role": nil},
			{"id": "inbox-b", "name": "Inbox", "parentId": "acct-b", "role": "inbox"},
			{"id": "trash-b", "name": "Trash", "parentId": "acct-b", "role": "trash"},
		}}
	case "Email/query":
		var flt struct {
			InMailbox string `json:"inMailbox"`
		}
		json.Unmarshal(args["filter"], &flt)
		ids := []string{}
		for _, m := range f.msgs {
			if m.mailbox == flt.InMailbox && f.moved[m.id] == "" {
				ids = append(ids, m.id)
			}
		}
		var lim, pos int
		json.Unmarshal(args["limit"], &lim)
		json.Unmarshal(args["position"], &pos)
		if f.ignoreLimit {
			return map[string]any{"ids": ids}
		}
		if pos > len(ids) {
			pos = len(ids)
		}
		ids = ids[pos:]
		if lim > 0 && len(ids) > lim {
			ids = ids[:lim]
		}
		return map[string]any{"ids": ids}
	case "Email/get":
		var ids []string
		json.Unmarshal(args["ids"], &ids)
		list := []map[string]any{}
		for _, id := range ids {
			for _, m := range f.msgs {
				if m.id == id {
					list = append(list, map[string]any{"id": id, "blobId": "blob-" + id, "size": len(m.raw)})
				}
			}
		}
		return map[string]any{"list": list}
	case "Email/set":
		var upd map[string]struct {
			MailboxIDs map[string]bool `json:"mailboxIds"`
		}
		json.Unmarshal(args["update"], &upd)
		res := map[string]any{}
		for id, u := range upd {
			for mb := range u.MailboxIDs {
				f.moved[id] = mb
			}
			res[id] = nil
		}
		return map[string]any{"updated": res}
	}
	return map[string]any{}
}

func (f *fakeJMAP) movedTo(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.moved[id]
}

func testServer(t *testing.T, f *fakeJMAP, mod func(*Config), tlsCfg *tls.Config, implicit bool) string {
	cfg := DefaultConfig()
	cfg.JMAPURL = f.srv.URL
	cfg.AllowInsecureAuth = !implicit
	cfg.IdleTimeout = 5 * time.Second
	if mod != nil {
		mod(&cfg)
	}
	jm, err := NewClient(cfg.JMAPURL)
	if err != nil {
		t.Fatal(err)
	}
	srv := NewServer(cfg, tlsCfg, jm, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go srv.Serve(ln, implicit)
	return ln.Addr().String()
}

type client struct {
	t  *testing.T
	c  net.Conn
	br *bufio.Reader
}

func dial(t *testing.T, addr string) *client {
	c, err := net.DialTimeout("tcp", addr, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	cl := &client{t: t, c: c, br: bufio.NewReader(c)}
	cl.ok()
	return cl
}

func (c *client) line() string {
	c.c.SetReadDeadline(time.Now().Add(5 * time.Second))
	l, err := c.br.ReadString('\n')
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	return strings.TrimRight(l, "\r\n")
}
func (c *client) ok() string {
	l := c.line()
	if !strings.HasPrefix(l, "+OK") {
		c.t.Fatalf("want +OK, got %q", l)
	}
	return l
}
func (c *client) err() string {
	l := c.line()
	if !strings.HasPrefix(l, "-ERR") {
		c.t.Fatalf("want -ERR, got %q", l)
	}
	return l
}
func (c *client) send(s string) { fmt.Fprintf(c.c, "%s\r\n", s) }
func (c *client) multi() []string {
	var out []string
	for {
		l := c.line()
		if l == "." {
			return out
		}
		out = append(out, l)
	}
}
func (c *client) login(user, pw string) {
	c.send("USER " + user)
	c.ok()
	c.send("PASS " + pw)
	c.ok()
}

func TestLoginOKAndFail(t *testing.T) {
	f := newFakeJMAP(t)
	addr := testServer(t, f, nil, nil, false)
	c := dial(t, addr)
	c.send("USER a@x.test")
	c.ok()
	c.send("PASS wrong")
	if l := c.err(); !strings.Contains(l, "AUTH") {
		t.Fatal(l)
	}
	c.send("STAT")
	c.err() // not authenticated
	c.send("USER a@x.test")
	c.ok()
	c.send("PASS " + goodKey)
	c.ok()
	c.send("STAT")
	if l := c.ok(); !strings.HasPrefix(l, "+OK 2 ") {
		t.Fatalf("stat %q (only mailbox a inbox expected)", l)
	}
}

func TestUnknownUserUsesAllInboxes(t *testing.T) {
	f := newFakeJMAP(t)
	c := dial(t, testServer(t, f, nil, nil, false))
	c.login("someone@else.test", goodKey)
	c.send("STAT")
	if l := c.ok(); !strings.HasPrefix(l, "+OK 3 ") {
		t.Fatalf("stat %q", l)
	}
}

func TestListUidlRetrTop(t *testing.T) {
	f := newFakeJMAP(t)
	c := dial(t, testServer(t, f, nil, nil, false))
	c.login("a@x.test", goodKey)

	c.send("LIST")
	c.ok()
	l := c.multi()
	if len(l) != 2 || l[0] != fmt.Sprintf("1 %d", len(f.msgs[0].raw)) {
		t.Fatalf("list %v", l)
	}
	c.send("LIST 2")
	if r := c.ok(); r != fmt.Sprintf("+OK 2 %d", len(f.msgs[1].raw)) {
		t.Fatal(r)
	}
	c.send("UIDL")
	c.ok()
	if u := c.multi(); u[0] != "1 e1" || u[1] != "2 e2" {
		t.Fatalf("uidl %v", u)
	}
	c.send("UIDL 2")
	if r := c.ok(); r != "+OK 2 e2" {
		t.Fatal(r)
	}

	c.send("RETR 1")
	c.ok()
	got := c.multi()
	want := []string{"Subject: one", "", "hello", "..dot line", "bye"} // dot-stuffed
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("retr %q", got)
	}

	c.send("RETR 2") // bare LF source normalised to CRLF (line() trims, so check raw below)
	c.ok()
	if g := c.multi(); len(g) != 6 || g[5] != "line3" {
		t.Fatalf("retr2 %q", g)
	}

	c.send("TOP 1 1")
	c.ok()
	if g := c.multi(); strings.Join(g, "|") != "Subject: one||hello" {
		t.Fatalf("top %q", g)
	}
	c.send("TOP 2 0")
	c.ok()
	if g := c.multi(); strings.Join(g, "|") != "Subject: two|From: x@y.z|" {
		t.Fatalf("top0 %q", g)
	}
	c.send("RETR 9")
	c.err()
	c.send("RETR abc")
	c.err()
}

func TestDeleQuitMovesToTrash(t *testing.T) {
	f := newFakeJMAP(t)
	addr := testServer(t, f, nil, nil, false)
	c := dial(t, addr)
	c.login("a@x.test", goodKey)
	c.send("DELE 1")
	c.ok()
	c.send("DELE 1")
	c.err()
	c.send("STAT")
	if l := c.ok(); !strings.HasPrefix(l, "+OK 1 ") {
		t.Fatal(l)
	}
	if f.movedTo("e1") != "" {
		t.Fatal("moved before QUIT")
	}
	c.send("QUIT")
	c.ok()
	if got := f.movedTo("e1"); got != "trash-a" {
		t.Fatalf("e1 moved to %q", got)
	}
	if f.movedTo("e2") != "" {
		t.Fatal("e2 should not move")
	}
}

func TestDroppedConnectionDoesNotDelete(t *testing.T) {
	f := newFakeJMAP(t)
	c := dial(t, testServer(t, f, nil, nil, false))
	c.login("a@x.test", goodKey)
	c.send("DELE 1")
	c.ok()
	c.c.Close()
	time.Sleep(100 * time.Millisecond)
	if f.movedTo("e1") != "" {
		t.Fatal("deleted without QUIT")
	}
}

func TestRsetKeepsMessages(t *testing.T) {
	f := newFakeJMAP(t)
	c := dial(t, testServer(t, f, nil, nil, false))
	c.login("a@x.test", goodKey)
	c.send("DELE 1")
	c.ok()
	c.send("DELE 2")
	c.ok()
	c.send("RSET")
	c.ok()
	c.send("STAT")
	if l := c.ok(); !strings.HasPrefix(l, "+OK 2 ") {
		t.Fatal(l)
	}
	c.send("QUIT")
	c.ok()
	if f.movedTo("e1") != "" || f.movedTo("e2") != "" {
		t.Fatal("RSET'd messages moved")
	}
}

func TestDeleteModeKeep(t *testing.T) {
	f := newFakeJMAP(t)
	c := dial(t, testServer(t, f, func(c *Config) { c.DeleteMode = "keep" }, nil, false))
	c.login("a@x.test", goodKey)
	c.send("DELE 1")
	c.ok()
	c.send("QUIT")
	c.ok()
	if f.movedTo("e1") != "" {
		t.Fatal("keep mode moved a message")
	}
}

func TestCapa(t *testing.T) {
	f := newFakeJMAP(t)
	c := dial(t, testServer(t, f, nil, nil, false))
	c.send("CAPA")
	c.ok()
	caps := strings.Join(c.multi(), ",")
	for _, w := range []string{"TOP", "UIDL", "USER"} {
		if !strings.Contains(caps, w) {
			t.Fatalf("missing %s in %s", w, caps)
		}
	}
}

func TestRateLimitByIP(t *testing.T) {
	f := newFakeJMAP(t)
	addr := testServer(t, f, func(c *Config) { c.MaxFailures = 3 }, nil, false)
	for i := 0; i < 3; i++ {
		c := dial(t, addr)
		c.send(fmt.Sprintf("USER u%d@x.test", i))
		c.ok()
		c.send("PASS bad")
		c.err()
	}
	c := dial(t, addr)
	c.send("USER a@x.test")
	c.ok()
	c.send("PASS " + goodKey) // correct password, but IP is blocked
	if l := c.err(); !strings.Contains(l, "LOGIN-DELAY") {
		t.Fatal(l)
	}
}

func TestLimiterWindowAndUserKey(t *testing.T) {
	now := time.Unix(1000, 0)
	l := NewLimiter(2, time.Minute)
	l.now = func() time.Time { return now }
	l.Fail("k")
	if l.Blocked("k") {
		t.Fatal("blocked early")
	}
	l.Fail("k")
	if !l.Blocked("k") {
		t.Fatal("not blocked")
	}
	now = now.Add(61 * time.Second)
	if l.Blocked("k") {
		t.Fatal("still blocked after window")
	}
}

func TestLimiterBoundedMemory(t *testing.T) {
	l := NewLimiter(3, time.Hour)
	l.maxKeys = 50
	for i := 0; i < 1000; i++ {
		l.Fail(fmt.Sprintf("k%d", i))
	}
	if n := l.Len(); n > 50 {
		t.Fatalf("limiter grew to %d keys", n)
	}
}

func TestLimiterIncrementalPrune(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewLimiter(3, time.Minute)
	l.now = func() time.Time { return now }
	for i := 0; i < 100; i++ {
		l.Fail(fmt.Sprintf("old%d", i))
	}
	now = now.Add(2 * time.Minute)
	for i := 0; i < 200; i++ {
		l.Fail("new")
	}
	if n := l.Len(); n > 5 {
		t.Fatalf("expired keys not pruned incrementally: %d", n)
	}
}

func TestIPKeyV6Prefix(t *testing.T) {
	if ipKey("2001:db8:1:2::1") != ipKey("2001:db8:1:2:ffff::9") {
		t.Fatal("same /64 must share a key")
	}
	if ipKey("2001:db8:1:2::1") == ipKey("2001:db8:1:3::1") {
		t.Fatal("different /64 must differ")
	}
	if ipKey("192.0.2.1") != "192.0.2.1" {
		t.Fatal("v4 key")
	}
}

func TestRateLimitByPresentedKey(t *testing.T) {
	f := newFakeJMAP(t)
	addr := testServer(t, f, func(c *Config) { c.MaxFailures = 2; c.MaxConnsPerIP = 50 }, nil, false)
	// A victim username does not lock the victim out: failures with a
	// different guess on another IP-limit budget never block the real key.
	c := dial(t, addr)
	c.send("USER victim@x.test")
	c.ok()
	c.send("PASS guess1")
	c.err()
	c.send("PASS guess1")
	c.err()
	c2 := dial(t, addr)
	c2.send("USER victim@x.test")
	c2.ok()
	c2.send("PASS guess1") // same wrong key repeatedly: blocked
	if l := c2.err(); !strings.Contains(l, "LOGIN-DELAY") {
		t.Fatal(l)
	}
}

func TestSuccessDoesNotResetIPLimit(t *testing.T) {
	f := newFakeJMAP(t)
	addr := testServer(t, f, func(c *Config) { c.MaxFailures = 3; c.MaxConnsPerIP = 50 }, nil, false)
	for i := 0; i < 3; i++ {
		c := dial(t, addr)
		c.send("USER a@x.test")
		c.ok()
		c.send(fmt.Sprintf("PASS bad%d", i))
		c.err()
		d := dial(t, addr) // attacker logs into own account between guesses (blocked only once limit hit)
		_ = d
	}
	c := dial(t, addr)
	c.send("USER mine@x.test")
	c.ok()
	c.send("PASS " + goodKey)
	if l := c.err(); !strings.Contains(l, "LOGIN-DELAY") {
		t.Fatal("IP limit was reset or bypassed: " + l)
	}
}

func TestGlobalFailureRateSlowsLogins(t *testing.T) {
	f := newFakeJMAP(t)
	addr := testServer(t, f, func(c *Config) { c.GlobalFailPerMin = 1; c.MaxFailures = 50; c.slowDelay = 400 * time.Millisecond }, nil, false)
	c := dial(t, addr)
	c.send("USER a@x.test")
	c.ok()
	c.send("PASS bad")
	c.err()
	start := time.Now()
	c.send("PASS " + goodKey)
	c.ok()
	if time.Since(start) < 350*time.Millisecond {
		t.Fatal("login not slowed under global failure rate")
	}
}

func TestDropAfterThreeBadPasswords(t *testing.T) {
	f := newFakeJMAP(t)
	addr := testServer(t, f, func(c *Config) { c.MaxFailures = 50 }, nil, false)
	c := dial(t, addr)
	c.send("USER a@x.test")
	c.ok()
	for i := 0; i < 3; i++ {
		c.send(fmt.Sprintf("PASS bad%d", i))
		c.err()
	}
	c.c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.br.ReadString('\n'); err == nil {
		t.Fatal("connection still open after 3 failed PASS")
	}
}

func TestPreAuthCommandCap(t *testing.T) {
	f := newFakeJMAP(t)
	c := dial(t, testServer(t, f, nil, nil, false))
	for i := 0; i < maxPreAuthCmds; i++ {
		c.send("NOOP")
		c.ok()
	}
	c.send("NOOP")
	c.err()
}

func TestAbsoluteAuthDeadline(t *testing.T) {
	f := newFakeJMAP(t)
	c := dial(t, testServer(t, f, func(c *Config) { c.AuthTimeout = 500 * time.Millisecond }, nil, false))
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		c.send("NOOP") // keeps the connection "active"
		c.c.SetReadDeadline(time.Now().Add(2 * time.Second))
		l, err := c.br.ReadString('\n')
		if err != nil || strings.HasPrefix(l, "-ERR") {
			return // dropped or told off by the absolute deadline
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("connection survived past the absolute pre-auth deadline")
}

func TestPassNotTrimmedAndControlCharsCounted(t *testing.T) {
	f := newFakeJMAP(t)
	c := dial(t, testServer(t, f, func(c *Config) { c.MaxFailures = 50 }, nil, false))
	c.send("USER a@x.test")
	c.ok()
	c.send("PASS  " + goodKey) // leading space is part of the password
	c.err()
	c.send("PASS " + goodKey + "\rX") // embedded CR
	c.err()
}

func TestTLSHandshakeTimeout(t *testing.T) {
	f := newFakeJMAP(t)
	addr := testServer(t, f, func(c *Config) { c.handshakeTimeout = 200 * time.Millisecond }, selfSigned(t), true)
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("expected server to drop a stalled handshake")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("server did not drop stalled handshake")
	}
}

type flakyListener struct {
	net.Listener
	mu   sync.Mutex
	errs int
}

type tempErr struct{}

func (tempErr) Error() string   { return "temporary" }
func (tempErr) Timeout() bool   { return false }
func (tempErr) Temporary() bool { return true }

func (l *flakyListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	if l.errs > 0 {
		l.errs--
		l.mu.Unlock()
		return nil, tempErr{}
	}
	l.mu.Unlock()
	return l.Listener.Accept()
}

func TestAcceptSurvivesTemporaryErrors(t *testing.T) {
	f := newFakeJMAP(t)
	cfg := DefaultConfig()
	cfg.JMAPURL = f.srv.URL
	cfg.AllowInsecureAuth = true
	jm, _ := NewClient(cfg.JMAPURL)
	srv := NewServer(cfg, nil, jm, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	go srv.Serve(&flakyListener{Listener: ln, errs: 3}, false)
	c := dial(t, ln.Addr().String())
	c.login("a@x.test", goodKey)
}

func TestMaxMessagesKeepsNewest(t *testing.T) {
	f := newFakeJMAP(t)
	c := dial(t, testServer(t, f, func(c *Config) { c.MaxMessages = 1 }, nil, false))
	c.login("a@x.test", goodKey)
	c.send("UIDL")
	c.ok()
	if u := c.multi(); len(u) != 1 || u[0] != "1 e2" {
		t.Fatalf("expected newest message only, got %v", u)
	}
}

func TestOversizedQueryPageRejected(t *testing.T) {
	f := newFakeJMAP(t)
	for i := 0; i < queryPage+5; i++ {
		f.msgs = append(f.msgs, fakeMsg{fmt.Sprintf("x%d", i), "inbox-a", "S: x\r\n\r\n"})
	}
	f.ignoreLimit = true
	c := dial(t, testServer(t, f, nil, nil, false))
	c.send("USER a@x.test")
	c.ok()
	c.send("PASS " + goodKey)
	if l := c.err(); !strings.Contains(l, "SYS/TEMP") {
		t.Fatal(l)
	}
}

func TestInvalidBlobIDRejected(t *testing.T) {
	f := newFakeJMAP(t)
	c, _ := NewClient(f.srv.URL)
	a, err := c.Login(context.Background(), goodKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "../x", "a/b", "a?b", "a b", "a\nb"} {
		if _, err := a.Download(context.Background(), bad); err == nil {
			t.Fatalf("blob id %q accepted", bad)
		}
	}
}

func TestRedirectsNotFollowed(t *testing.T) {
	hit := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit = true }))
	defer target.Close()
	redir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/jmap/session", http.StatusFound)
	}))
	defer redir.Close()
	c, _ := NewClient(redir.URL)
	if _, err := c.Login(context.Background(), "k"); err == nil || err == ErrAuth {
		t.Fatalf("expected non-auth error on redirect, got %v", err)
	}
	if hit {
		t.Fatal("redirect was followed")
	}
}

func TestCredentialsDirectoryDefaults(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(dir+"/tls.crt", []byte("x"), 0o600)
	os.WriteFile(dir+"/tls.key", []byte("x"), 0o600)
	t.Setenv("CREDENTIALS_DIRECTORY", dir)
	c := DefaultConfig()
	c.useSystemdCredentials()
	if c.TLSCert != dir+"/tls.crt" || c.TLSKey != dir+"/tls.key" {
		t.Fatalf("%+v", c)
	}
}

func TestConnectionLimit(t *testing.T) {
	f := newFakeJMAP(t)
	addr := testServer(t, f, func(c *Config) { c.MaxConnsPerIP = 1 }, nil, false)
	_ = dial(t, addr)
	c2, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	c2.SetReadDeadline(time.Now().Add(3 * time.Second))
	l, _ := bufio.NewReader(c2).ReadString('\n')
	if !strings.HasPrefix(l, "-ERR too many") {
		t.Fatalf("got %q", l)
	}
}

func TestLongLineRejected(t *testing.T) {
	f := newFakeJMAP(t)
	c := dial(t, testServer(t, f, nil, nil, false))
	c.send("USER " + strings.Repeat("a", 5000))
	c.err()
}

func TestIdleTimeout(t *testing.T) {
	f := newFakeJMAP(t)
	c := dial(t, testServer(t, f, func(c *Config) { c.IdleTimeout = 300 * time.Millisecond; c.AuthTimeout = 300 * time.Millisecond }, nil, false))
	if l := c.err(); !strings.Contains(l, "timeout") {
		t.Fatal(l)
	}
}

func selfSigned(t *testing.T) *tls.Config {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
}

func TestPlaintextPassRefusedAndTLSWorks(t *testing.T) {
	f := newFakeJMAP(t)
	tcfg := selfSigned(t)

	// Plain listener without allow_insecure_auth: PASS refused, STLS advertised.
	addr := testServer(t, f, func(c *Config) { c.AllowInsecureAuth = false }, tcfg, false)
	c := dial(t, addr)
	c.send("CAPA")
	c.ok()
	if !strings.Contains(strings.Join(c.multi(), ","), "STLS") {
		t.Fatal("STLS not advertised")
	}
	c.send("USER a@x.test")
	c.ok()
	c.send("PASS " + goodKey)
	if l := c.err(); !strings.Contains(l, "Plaintext") {
		t.Fatal(l)
	}
	// Upgrade with STLS and log in.
	c.send("STLS")
	c.ok()
	tc := tls.Client(c.c, &tls.Config{InsecureSkipVerify: true})
	if err := tc.Handshake(); err != nil {
		t.Fatal(err)
	}
	c2 := &client{t: t, c: tc, br: bufio.NewReader(tc)}
	c2.login("a@x.test", goodKey)
	c2.send("STAT")
	c2.ok()

	// Implicit TLS listener.
	addr2 := testServer(t, f, nil, tcfg, true)
	raw, err := tls.Dial("tcp", addr2, &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	c3 := &client{t: t, c: raw, br: bufio.NewReader(raw)}
	c3.ok()
	c3.login("a@x.test", goodKey)
}

func TestDotStuffedWriter(t *testing.T) {
	cases := []struct {
		in   string
		top  int
		want string
	}{
		{"A: b\r\n\r\n.x\r\n..y\r\n", -1, "A: b\r\n\r\n..x\r\n...y\r\n.\r\n"},
		{"A: b\n\nline", -1, "A: b\r\n\r\nline\r\n.\r\n"},
		{"A: b\r\n\r\n1\r\n2\r\n3\r\n", 2, "A: b\r\n\r\n1\r\n2\r\n.\r\n"},
		{"A: b\r\n\r\n1\r\n", 0, "A: b\r\n\r\n.\r\n"},
		{"A: b\r\n", 5, "A: b\r\n.\r\n"},
		{"", -1, ".\r\n"},
		{"." + strings.Repeat("z", 70000) + "\r\n", -1, ".." + strings.Repeat("z", 70000) + "\r\n.\r\n"},
	}
	for i, tc := range cases {
		var buf bytes.Buffer
		w := bufio.NewWriter(&buf)
		if err := writeDotStuffed(w, strings.NewReader(tc.in), tc.top); err != nil {
			t.Fatal(err)
		}
		w.Flush()
		if buf.String() != tc.want {
			t.Errorf("case %d: got %q want %q", i, buf.String(), tc.want)
		}
	}
}

func TestRejectsCrossOriginSession(t *testing.T) {
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"apiUrl": "http://evil.example/api", "downloadUrl": "http://evil.example/d",
			"primaryAccounts": map[string]string{capMail: "x"}})
	}))
	defer evil.Close()
	c, _ := NewClient(evil.URL)
	if _, err := c.Login(context.Background(), "k"); err == nil || err == ErrAuth {
		t.Fatalf("expected origin error, got %v", err)
	}
}

func TestConfigEnvAndValidate(t *testing.T) {
	c := DefaultConfig()
	env := map[string]string{"MFPOP3_DELETE_MODE": "keep", "MFPOP3_MAX_FAILURES": "9", "MFPOP3_FAIL_WINDOW": "5m",
		"MFPOP3_TLS_CERT": "c", "MFPOP3_TLS_KEY": "k"}
	if err := c.applyEnv(func(k string) string { return env[k] }); err != nil {
		t.Fatal(err)
	}
	if c.DeleteMode != "keep" || c.MaxFailures != 9 || c.FailWindow != 5*time.Minute {
		t.Fatalf("%+v", c)
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.DeleteMode = "destroy"
	if c.Validate() == nil {
		t.Fatal("bad delete_mode accepted")
	}
}
