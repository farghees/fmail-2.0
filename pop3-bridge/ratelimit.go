package main

import (
	"net"
	"sync"
	"time"
)

const (
	limiterMaxKeys = 100000 // hard cap on tracked keys
	pruneStep      = 8      // keys examined for expiry per Fail call
)

// Limiter blocks a key after max failures within window. A blocked key stays
// blocked until its oldest counted failure ages out of the window. Memory is
// bounded: expired keys are pruned incrementally and, when the map is full,
// an arbitrary entry is evicted to make room.
type Limiter struct {
	mu      sync.Mutex
	max     int
	window  time.Duration
	maxKeys int
	now     func() time.Time
	fails   map[string][]time.Time
}

func NewLimiter(max int, window time.Duration) *Limiter {
	return &Limiter{max: max, window: window, maxKeys: limiterMaxKeys, now: time.Now, fails: map[string][]time.Time{}}
}

func (l *Limiter) prune(key string, now time.Time) []time.Time {
	ts := l.fails[key]
	i := 0
	for i < len(ts) && now.Sub(ts[i]) >= l.window {
		i++
	}
	ts = ts[i:]
	if len(ts) == 0 {
		delete(l.fails, key)
		return nil
	}
	l.fails[key] = ts
	return ts
}

// Blocked reports whether key is currently blocked.
func (l *Limiter) Blocked(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.prune(key, l.now())) >= l.max
}

// Fail records a failure.
func (l *Limiter) Fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	// Incremental sweep: Go map iteration order is random, so repeated calls
	// cover the whole map without an O(n) pass under the lock.
	n := 0
	for k := range l.fails {
		if n++; n > pruneStep {
			break
		}
		if k != key {
			l.prune(k, now)
		}
	}
	ts := l.prune(key, now)
	if ts == nil && len(l.fails) >= l.maxKeys {
		for k := range l.fails { // evict one arbitrary entry
			delete(l.fails, k)
			break
		}
	}
	if len(ts) < l.max { // do not extend the block indefinitely
		l.fails[key] = append(ts, now)
	}
}

// Len returns the number of tracked keys.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.fails)
}

// ipKey normalises an address for limiting: IPv6 is keyed by its /64.
func ipKey(ip string) string {
	p := net.ParseIP(ip)
	if p == nil {
		return ip
	}
	if p.To4() != nil {
		return p.String()
	}
	return p.Mask(net.CIDRMask(64, 128)).String() + "/64"
}
