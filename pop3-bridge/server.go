package main

import (
	"bufio"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Server is the POP3 front end.
type Server struct {
	cfg     Config
	tlsCfg  *tls.Config
	jmap    *Client
	byIP    *Limiter
	byKey   *Limiter // keyed on SHA-256 of the presented password
	global  *Limiter // all failures; when exceeded every login is slowed
	slow    time.Duration
	log     *slog.Logger
	mu      sync.Mutex
	total   int
	perIP   map[string]int
	writeTO time.Duration
}

func NewServer(cfg Config, tlsCfg *tls.Config, jmap *Client, log *slog.Logger) *Server {
	return &Server{
		cfg: cfg, tlsCfg: tlsCfg, jmap: jmap, log: log,
		byIP:    NewLimiter(cfg.MaxFailures, cfg.FailWindow),
		byKey:   NewLimiter(cfg.MaxFailures, cfg.FailWindow),
		global:  NewLimiter(cfg.GlobalFailPerMin, time.Minute),
		slow:    orDefault(cfg.slowDelay, 2*time.Second),
		perIP:   map[string]int{},
		writeTO: 2 * time.Minute,
	}
}

// Serve accepts connections until ln is closed. implicitTLS wraps each
// connection in TLS immediately.
func (s *Server) Serve(ln net.Listener, implicitTLS bool) error {
	var delay time.Duration
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return err
			}
			// Temporary failures (e.g. EMFILE) must not kill the listener.
			if delay == 0 {
				delay = 5 * time.Millisecond
			} else if delay *= 2; delay > time.Second {
				delay = time.Second
			}
			s.log.Warn("accept error, retrying", "err", err.Error(), "delay", delay.String())
			time.Sleep(delay)
			continue
		}
		delay = 0
		ip := remoteIP(c)
		if !s.acquire(ip) {
			s.log.Warn("connection limit", "ip", ip)
			c.SetWriteDeadline(time.Now().Add(5 * time.Second))
			io.WriteString(c, "-ERR too many connections\r\n")
			c.Close()
			continue
		}
		go s.serveConn(c, ip, implicitTLS)
	}
}

func (s *Server) serveConn(c net.Conn, ip string, implicitTLS bool) {
	defer s.release(ip)
	defer c.Close()
	defer func() {
		if r := recover(); r != nil {
			s.log.Error("panic in connection", "ip", ip, "panic", fmt.Sprint(r))
		}
	}()
	conn := c
	if implicitTLS {
		tc := tls.Server(c, s.tlsCfg)
		c.SetDeadline(time.Now().Add(orDefault(s.cfg.handshakeTimeout, 10*time.Second)))
		if err := tc.Handshake(); err != nil {
			s.log.Info("tls handshake failed", "ip", ip)
			return
		}
		c.SetDeadline(time.Time{})
		conn = tc
	}
	s.handle(conn, ip)
}

func remoteIP(c net.Conn) string {
	h, _, err := net.SplitHostPort(c.RemoteAddr().String())
	if err != nil {
		return c.RemoteAddr().String()
	}
	return h
}

func (s *Server) acquire(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.total >= s.cfg.MaxConns || s.perIP[ip] >= s.cfg.MaxConnsPerIP {
		return false
	}
	s.total++
	s.perIP[ip]++
	return true
}

func (s *Server) release(ip string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.total--
	if s.perIP[ip]--; s.perIP[ip] <= 0 {
		delete(s.perIP, ip)
	}
}

type session struct {
	s      *Server
	conn   net.Conn
	br     *bufio.Reader
	bw     *bufio.Writer
	ip     string
	user   string
	acct   *Account
	msgs   []Message
	gone   []bool
	authed bool
	start  time.Time
	preCmd int
	badPW  int
	badArg bool
	ctx    context.Context
	cancel context.CancelFunc
}

const (
	retrTimeout    = 10 * time.Minute // overall cap per RETR/TOP
	maxPreAuthCmds = 20
	maxBadPass     = 3
)

func hasCtl(s string) bool { return strings.ContainsAny(s, "\r\n\x00") }

var errLineTooLong = errors.New("line too long")

func (se *session) readLine() (string, error) {
	timeout := se.s.cfg.IdleTimeout
	if !se.authed && se.s.cfg.AuthTimeout > 0 {
		// Absolute deadline to reach TRANSACTION, not reset by activity.
		if rem := se.start.Add(se.s.cfg.AuthTimeout).Sub(time.Now()); rem < timeout {
			timeout = rem
		}
	}
	if timeout <= 0 {
		timeout = time.Millisecond
	}
	se.conn.SetReadDeadline(time.Now().Add(timeout))
	var line []byte
	for {
		part, err := se.br.ReadSlice('\n')
		line = append(line, part...)
		if len(line) > se.s.cfg.MaxLine {
			return "", errLineTooLong
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			return "", err
		}
		break
	}
	return strings.TrimRight(string(line), "\r\n"), nil
}

func (se *session) reply(format string, a ...any) error {
	se.conn.SetWriteDeadline(time.Now().Add(se.s.writeTO))
	fmt.Fprintf(se.bw, format+"\r\n", a...)
	return se.bw.Flush()
}

func isTLS(c net.Conn) bool { _, ok := c.(*tls.Conn); return ok }

func (s *Server) handle(conn net.Conn, ip string) {
	ctx, cancel := context.WithCancel(context.Background())
	se := &session{s: s, conn: conn, ip: ip, ctx: ctx, cancel: cancel, start: time.Now(),
		br: bufio.NewReaderSize(conn, 4096), bw: bufio.NewWriterSize(conn, 32*1024)}
	defer cancel()
	s.log.Info("connect", "ip", ip, "tls", isTLS(conn))
	defer s.log.Info("disconnect", "ip", ip, "user", se.user)
	if se.reply("+OK Mailflare POP3 bridge ready") != nil {
		return
	}
	se.run()
}

func (se *session) caps() []string {
	c := []string{"TOP", "UIDL", "USER", "RESP-CODES", "PIPELINING", "EXPIRE NEVER", "IMPLEMENTATION mailflare-pop3"}
	if !isTLS(se.conn) && se.s.tlsCfg != nil && !se.authed {
		c = append(c, "STLS")
	}
	return c
}

func (se *session) run() {
	for {
		line, err := se.readLine()
		if err != nil {
			if errors.Is(err, errLineTooLong) {
				se.reply("-ERR line too long")
			} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
				se.reply("-ERR timeout")
			}
			return
		}
		cmd, arg, _ := strings.Cut(line, " ")
		cmd = strings.ToUpper(cmd)
		if cmd != "PASS" { // a password may legitimately start or end with spaces
			arg = strings.TrimSpace(arg)
		}
		if !se.authed {
			if se.preCmd++; se.preCmd > maxPreAuthCmds {
				se.reply("-ERR too many commands")
				return
			}
			if !se.authState(cmd, arg) {
				return
			}
			continue
		}
		if !se.transaction(cmd, arg) {
			return
		}
	}
}

// authState handles AUTHORIZATION-state commands; false ends the session.
func (se *session) authState(cmd, arg string) bool {
	switch cmd {
	case "CAPA":
		se.conn.SetWriteDeadline(time.Now().Add(se.s.writeTO))
		se.bw.WriteString("+OK Capability list follows\r\n")
		for _, c := range se.caps() {
			se.bw.WriteString(c + "\r\n")
		}
		se.bw.WriteString(".\r\n")
		return se.bw.Flush() == nil
	case "STLS":
		if isTLS(se.conn) || se.s.tlsCfg == nil {
			return se.reply("-ERR STLS not available") == nil
		}
		if se.reply("+OK Begin TLS negotiation") != nil {
			return false
		}
		tc := tls.Server(se.conn, se.s.tlsCfg)
		se.conn.SetDeadline(time.Now().Add(30 * time.Second))
		if err := tc.Handshake(); err != nil {
			return false
		}
		se.conn = tc
		se.br = bufio.NewReaderSize(tc, 4096)
		se.bw = bufio.NewWriterSize(tc, 32*1024)
		se.user = ""
		return true
	case "USER":
		if arg == "" {
			return se.reply("-ERR missing username") == nil
		}
		if hasCtl(arg) {
			se.badArg = true // counted as an auth failure at PASS
			arg = "invalid"
		}
		se.user = arg
		return se.reply("+OK") == nil
	case "PASS":
		return se.pass(arg)
	case "NOOP":
		return se.reply("+OK") == nil
	case "QUIT":
		se.reply("+OK bye")
		return false
	default:
		return se.reply("-ERR command not valid in this state") == nil
	}
}

func (se *session) pass(pw string) bool {
	if se.user == "" {
		return se.reply("-ERR send USER first") == nil
	}
	if !isTLS(se.conn) && !se.s.cfg.AllowInsecureAuth {
		se.s.log.Warn("plaintext login refused", "ip", se.ip)
		return se.reply("-ERR [AUTH] Plaintext logins are disallowed; use TLS") == nil
	}
	ikey := ipKey(se.ip)
	sum := sha256.Sum256([]byte(pw))
	kkey := string(sum[:])
	if se.s.byIP.Blocked(ikey) || se.s.byKey.Blocked(kkey) {
		se.s.log.Warn("login blocked", "ip", se.ip, "user", se.user)
		se.reply("-ERR [LOGIN-DELAY] Too many failed logins; try again later")
		return false
	}
	if se.s.global.Blocked("g") { // under attack: slow every login
		time.Sleep(se.s.slow)
	}
	if se.badArg || hasCtl(pw) {
		se.badArg = false
		return se.authFail(ikey, kkey)
	}
	ctx, cancel := context.WithTimeout(se.ctx, 60*time.Second)
	defer cancel()
	acct, err := se.s.jmap.Login(ctx, pw)
	if err == nil {
		var msgs []Message
		if msgs, err = acct.Maildrop(ctx, se.user, se.s.cfg.MaxMessages); err == nil {
			se.acct, se.msgs, se.gone, se.authed = acct, msgs, make([]bool, len(msgs)), true
			se.s.log.Info("auth ok", "ip", se.ip, "user", se.user, "messages", len(msgs))
			return se.reply("+OK maildrop ready, %d messages", len(msgs)) == nil
		}
	}
	if errors.Is(err, ErrAuth) {
		return se.authFail(ikey, kkey)
	}
	se.s.log.Error("backend error", "ip", se.ip, "user", se.user, "err", err.Error())
	return se.reply("-ERR [SYS/TEMP] Backend unavailable") == nil
}

// authFail records a failed login; the connection is dropped after too many.
func (se *session) authFail(ikey, kkey string) bool {
	se.s.byIP.Fail(ikey)
	se.s.byKey.Fail(kkey)
	se.s.global.Fail("g")
	se.s.log.Warn("auth failed", "ip", se.ip, "user", se.user)
	se.badPW++
	if se.reply("-ERR [AUTH] Invalid credentials") != nil {
		return false
	}
	return se.badPW < maxBadPass
}

func (se *session) parseNum(arg string) (int, bool) {
	n, err := strconv.Atoi(arg)
	if err != nil || n < 1 || n > len(se.msgs) {
		se.reply("-ERR no such message")
		return 0, false
	}
	if se.gone[n-1] {
		se.reply("-ERR message already deleted")
		return 0, false
	}
	return n - 1, true
}

func uidl(id string) string {
	ok := len(id) > 0 && len(id) <= 70
	for i := 0; ok && i < len(id); i++ {
		ok = id[i] >= 0x21 && id[i] <= 0x7e
	}
	if ok {
		return id
	}
	h := sha1.Sum([]byte(id))
	return hex.EncodeToString(h[:])
}

func (se *session) stat() (n int, size int64) {
	for i, m := range se.msgs {
		if !se.gone[i] {
			n++
			size += m.Size
		}
	}
	return
}

// transaction handles TRANSACTION-state commands; false ends the session.
func (se *session) transaction(cmd, arg string) bool {
	switch cmd {
	case "CAPA":
		return se.authState(cmd, arg)
	case "NOOP":
		return se.reply("+OK") == nil
	case "USER", "PASS", "STLS":
		return se.reply("-ERR already authenticated") == nil
	case "STAT":
		n, sz := se.stat()
		return se.reply("+OK %d %d", n, sz) == nil
	case "LIST", "UIDL":
		return se.list(cmd == "UIDL", arg)
	case "DELE":
		i, ok := se.parseNum(arg)
		if !ok {
			return true
		}
		se.gone[i] = true
		return se.reply("+OK message %d deleted", i+1) == nil
	case "RSET":
		for i := range se.gone {
			se.gone[i] = false
		}
		return se.reply("+OK") == nil
	case "RETR":
		i, ok := se.parseNum(arg)
		if !ok {
			return true
		}
		return se.send(i, -1)
	case "TOP":
		f := strings.Fields(arg)
		if len(f) != 2 {
			return se.reply("-ERR usage: TOP msg lines") == nil
		}
		n, err := strconv.Atoi(f[1])
		if err != nil || n < 0 {
			return se.reply("-ERR invalid line count") == nil
		}
		i, ok := se.parseNum(f[0])
		if !ok {
			return true
		}
		return se.send(i, n)
	case "QUIT":
		return se.quit()
	default:
		return se.reply("-ERR unknown command") == nil
	}
}

func (se *session) list(isUIDL bool, arg string) bool {
	item := func(i int) string {
		if isUIDL {
			return fmt.Sprintf("%d %s", i+1, uidl(se.msgs[i].ID))
		}
		return fmt.Sprintf("%d %d", i+1, se.msgs[i].Size)
	}
	if arg != "" {
		i, ok := se.parseNum(arg)
		if !ok {
			return true
		}
		return se.reply("+OK %s", item(i)) == nil
	}
	n, sz := se.stat()
	se.conn.SetWriteDeadline(time.Now().Add(se.s.writeTO))
	if isUIDL {
		fmt.Fprintf(se.bw, "+OK\r\n")
	} else {
		fmt.Fprintf(se.bw, "+OK %d messages (%d octets)\r\n", n, sz)
	}
	for i := range se.msgs {
		if !se.gone[i] {
			fmt.Fprintf(se.bw, "%s\r\n", item(i))
		}
	}
	se.bw.WriteString(".\r\n")
	return se.bw.Flush() == nil
}

// send streams a message; a failure after "+OK" has gone out ends the session.
func (se *session) send(i, top int) bool {
	ctx, cancel := context.WithTimeout(se.ctx, retrTimeout)
	defer cancel()
	body, err := se.acct.Download(ctx, se.msgs[i].BlobID)
	if err != nil {
		se.s.log.Error("download failed", "ip", se.ip, "user", se.user, "err", err.Error())
		return se.reply("-ERR [SYS/TEMP] Cannot fetch message") == nil
	}
	defer body.Close()
	se.conn.SetWriteDeadline(time.Now().Add(se.s.writeTO))
	se.bw.WriteString("+OK\r\n")
	if err := writeDotStuffed(se.bw, &deadlineReader{r: body, c: se.conn, d: se.s.writeTO, limit: time.Now().Add(retrTimeout)}, top); err != nil {
		return false
	}
	return se.bw.Flush() == nil
}

// deadlineReader refreshes the write deadline as data flows, so slow but
// steady transfers of large messages are not cut off.
type deadlineReader struct {
	r     io.Reader
	c     net.Conn
	d     time.Duration
	limit time.Time // absolute cap for the whole transfer
}

func (d *deadlineReader) Read(p []byte) (int, error) {
	dl := time.Now().Add(d.d)
	if dl.After(d.limit) {
		dl = d.limit
	}
	d.c.SetWriteDeadline(dl)
	return d.r.Read(p)
}

func (se *session) quit() bool {
	var del []Message
	for i, g := range se.gone {
		if g {
			del = append(del, se.msgs[i])
		}
	}
	if len(del) == 0 || se.s.cfg.DeleteMode == "keep" {
		se.reply("+OK bye")
		return false
	}
	ctx, cancel := context.WithTimeout(se.ctx, 60*time.Second)
	defer cancel()
	moved, err := se.acct.MoveToTrash(ctx, del)
	if err != nil {
		se.s.log.Error("delete failed", "user", se.user, "moved", moved, "wanted", len(del), "err", err.Error())
		se.reply("-ERR [SYS/TEMP] Some messages were not removed")
		return false
	}
	se.s.log.Info("moved to trash", "user", se.user, "count", moved)
	se.reply("+OK bye")
	return false
}

func orDefault(d, def time.Duration) time.Duration {
	if d == 0 {
		return def
	}
	return d
}
