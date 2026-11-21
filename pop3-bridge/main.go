package main

import (
	"crypto/tls"
	"flag"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

// certStore holds the TLS certificate and reloads it on SIGHUP.
type certStore struct {
	mu         sync.RWMutex
	cert       *tls.Certificate
	certF, key string
}

func (c *certStore) reload() error {
	cert, err := tls.LoadX509KeyPair(c.certF, c.key)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.cert = &cert
	c.mu.Unlock()
	return nil
}

func (c *certStore) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.cert, nil
}

func main() {
	cfgPath := flag.String("config", os.Getenv("MFPOP3_CONFIG"), "path to YAML config (optional)")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	cfg, err := LoadConfig(*cfgPath)
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(2)
	}
	jm, err := NewClient(cfg.JMAPURL)
	if err != nil {
		log.Error("jmap client", "err", err)
		os.Exit(2)
	}

	var tlsCfg *tls.Config
	var store *certStore
	if cfg.TLSCert != "" && cfg.TLSKey != "" {
		store = &certStore{certF: cfg.TLSCert, key: cfg.TLSKey}
		if err := store.reload(); err != nil {
			log.Error("tls", "err", err)
			os.Exit(2)
		}
		tlsCfg = &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: store.get}
	}
	srv := NewServer(cfg, tlsCfg, jm, log)

	errc := make(chan error, 2)
	listen := func(addr string, implicit bool) {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			log.Error("listen", "addr", addr, "err", err)
			os.Exit(1)
		}
		log.Info("listening", "addr", addr, "tls", implicit)
		go func() { errc <- srv.Serve(ln, implicit) }()
	}
	if cfg.Listen != "" {
		listen(cfg.Listen, true)
	}
	if cfg.ListenPlain != "" {
		log.Warn("plaintext listener enabled", "addr", cfg.ListenPlain, "allow_insecure_auth", cfg.AllowInsecureAuth)
		listen(cfg.ListenPlain, false)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGHUP, syscall.SIGINT, syscall.SIGTERM)
	for {
		select {
		case s := <-sig:
			if s == syscall.SIGHUP {
				if store == nil {
					continue
				}
				if err := store.reload(); err != nil {
					log.Error("cert reload failed, keeping old cert", "err", err)
				} else {
					log.Info("certificate reloaded")
				}
				continue
			}
			log.Info("shutting down", "signal", s.String())
			return
		case err := <-errc:
			log.Error("serve", "err", err)
			os.Exit(1)
		}
	}
}
