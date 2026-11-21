package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Config is the bridge configuration. It is loaded from an optional YAML file
// and then overridden by MFPOP3_* environment variables.
type Config struct {
	JMAPURL           string        `yaml:"jmap_url"`
	Listen            string        `yaml:"listen"`       // implicit-TLS listener, default ":995"
	ListenPlain       string        `yaml:"listen_plain"` // plaintext listener (STLS offered), off by default
	TLSCert           string        `yaml:"tls_cert"`
	TLSKey            string        `yaml:"tls_key"`
	DeleteMode        string        `yaml:"delete_mode"` // "trash" | "keep"
	AllowInsecureAuth bool          `yaml:"allow_insecure_auth"`
	MaxFailures       int           `yaml:"max_failures"`
	FailWindow        time.Duration `yaml:"fail_window"`
	MaxConns          int           `yaml:"max_conns"`
	MaxConnsPerIP     int           `yaml:"max_conns_per_ip"`
	IdleTimeout       time.Duration `yaml:"idle_timeout"`
	AuthTimeout       time.Duration `yaml:"auth_timeout"`
	MaxLine           int           `yaml:"max_line"`
	MaxMessages       int           `yaml:"max_messages"` // newest N inbox messages kept per login
	slowDelay         time.Duration // test hook; zero = 2s
	handshakeTimeout  time.Duration // test hook; zero = 10s
	GlobalFailPerMin  int           `yaml:"global_fail_per_min"` // above this, all logins are slowed
}

// DefaultConfig returns the defaults.
func DefaultConfig() Config {
	return Config{
		JMAPURL:          "https://mail.example.com",
		Listen:           ":995",
		DeleteMode:       "trash",
		MaxFailures:      5,
		FailWindow:       10 * time.Minute,
		MaxConns:         200,
		MaxConnsPerIP:    10,
		IdleTimeout:      10 * time.Minute,
		AuthTimeout:      60 * time.Second,
		MaxLine:          1024,
		MaxMessages:      50000,
		GlobalFailPerMin: 100,
	}
}

// LoadConfig reads path (may be empty) and applies environment overrides.
func LoadConfig(path string) (Config, error) {
	c := DefaultConfig()
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return c, err
		}
		if err := yaml.Unmarshal(b, &c); err != nil {
			return c, fmt.Errorf("parse %s: %w", path, err)
		}
	}
	if err := c.applyEnv(os.Getenv); err != nil {
		return c, err
	}
	c.useSystemdCredentials()
	return c, c.Validate()
}

// useSystemdCredentials defaults the TLS paths to the files provided by
// systemd LoadCredential= (tls.crt / tls.key) when none are configured.
func (c *Config) useSystemdCredentials() {
	dir := os.Getenv("CREDENTIALS_DIRECTORY")
	if dir == "" || c.TLSCert != "" || c.TLSKey != "" {
		return
	}
	cert, key := dir+"/tls.crt", dir+"/tls.key"
	if _, err := os.Stat(cert); err == nil {
		if _, err := os.Stat(key); err == nil {
			c.TLSCert, c.TLSKey = cert, key
		}
	}
}

func (c *Config) applyEnv(get func(string) string) error {
	str := func(k string, dst *string) {
		if v := get(k); v != "" {
			*dst = v
		}
	}
	var err error
	num := func(k string, dst *int) {
		if v := get(k); v != "" {
			n, e := strconv.Atoi(v)
			if e != nil && err == nil {
				err = fmt.Errorf("%s: %w", k, e)
			}
			*dst = n
		}
	}
	dur := func(k string, dst *time.Duration) {
		if v := get(k); v != "" {
			d, e := time.ParseDuration(v)
			if e != nil && err == nil {
				err = fmt.Errorf("%s: %w", k, e)
			}
			*dst = d
		}
	}
	str("MFPOP3_JMAP_URL", &c.JMAPURL)
	str("MFPOP3_LISTEN", &c.Listen)
	str("MFPOP3_LISTEN_PLAIN", &c.ListenPlain)
	str("MFPOP3_TLS_CERT", &c.TLSCert)
	str("MFPOP3_TLS_KEY", &c.TLSKey)
	str("MFPOP3_DELETE_MODE", &c.DeleteMode)
	if v := get("MFPOP3_ALLOW_INSECURE_AUTH"); v != "" {
		c.AllowInsecureAuth = v == "1" || strings.EqualFold(v, "true")
	}
	num("MFPOP3_MAX_FAILURES", &c.MaxFailures)
	num("MFPOP3_MAX_CONNS", &c.MaxConns)
	num("MFPOP3_MAX_CONNS_PER_IP", &c.MaxConnsPerIP)
	num("MFPOP3_MAX_LINE", &c.MaxLine)
	num("MFPOP3_MAX_MESSAGES", &c.MaxMessages)
	num("MFPOP3_GLOBAL_FAIL_PER_MIN", &c.GlobalFailPerMin)
	dur("MFPOP3_FAIL_WINDOW", &c.FailWindow)
	dur("MFPOP3_IDLE_TIMEOUT", &c.IdleTimeout)
	dur("MFPOP3_AUTH_TIMEOUT", &c.AuthTimeout)
	return err
}

// Validate checks the configuration for consistency.
func (c Config) Validate() error {
	if c.JMAPURL == "" {
		return fmt.Errorf("jmap_url is required")
	}
	if c.DeleteMode != "trash" && c.DeleteMode != "keep" {
		return fmt.Errorf("delete_mode must be \"trash\" or \"keep\"")
	}
	if c.Listen == "" && c.ListenPlain == "" {
		return fmt.Errorf("no listener configured")
	}
	if c.Listen != "" && (c.TLSCert == "" || c.TLSKey == "") {
		return fmt.Errorf("tls_cert and tls_key are required for the TLS listener")
	}
	if c.MaxFailures < 1 || c.MaxConns < 1 || c.MaxConnsPerIP < 1 || c.MaxLine < 64 || c.MaxMessages < 1 || c.GlobalFailPerMin < 1 {
		return fmt.Errorf("limits must be positive (max_line >= 64)")
	}
	if c.IdleTimeout < time.Minute && c.IdleTimeout != 0 {
		// RFC 1939: autologout timer must be at least 10 minutes; we only warn-by-rule at 1 minute floor for tests.
		return fmt.Errorf("idle_timeout too small")
	}
	return nil
}
