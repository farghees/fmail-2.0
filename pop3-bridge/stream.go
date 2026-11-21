package main

import (
	"bufio"
	"io"
)

// writeDotStuffed copies a raw message from r to w as a POP3 multi-line
// payload: bare LF becomes CRLF, lines starting with '.' are byte-stuffed and
// the terminating ".\r\n" is appended. If topLines >= 0 only the headers plus
// that many body lines are sent (TOP); topLines < 0 sends everything (RETR).
func writeDotStuffed(w *bufio.Writer, r io.Reader, topLines int) error {
	br := bufio.NewReaderSize(r, 32*1024)
	atStart := true
	inBody := false
	bodyLines := 0
	var last byte = '\n'
	for {
		chunk, err := br.ReadSlice('\n')
		if len(chunk) > 0 {
			complete := chunk[len(chunk)-1] == '\n'
			if atStart {
				if inBody && topLines >= 0 && bodyLines >= topLines {
					break
				}
				if chunk[0] == '.' {
					if e := w.WriteByte('.'); e != nil {
						return e
					}
				}
			}
			if complete {
				body := chunk[:len(chunk)-1]
				var e error
				switch {
				case len(body) > 0 && body[len(body)-1] == '\r':
					if _, e = w.Write(body); e == nil {
						e = w.WriteByte('\n')
					}
				case len(body) == 0 && last == '\r':
					e = w.WriteByte('\n')
				default:
					if _, e = w.Write(body); e == nil {
						_, e = w.WriteString("\r\n")
					}
				}
				if e != nil {
					return e
				}
				blank := atStart && (len(body) == 0 || (len(body) == 1 && body[0] == '\r'))
				if blank && !inBody {
					inBody = true
				} else if inBody {
					bodyLines++
				}
				atStart = true
				last = '\n'
			} else {
				if _, e := w.Write(chunk); e != nil {
					return e
				}
				atStart = false
				last = chunk[len(chunk)-1]
			}
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	if !atStart {
		if _, e := w.WriteString("\r\n"); e != nil {
			return e
		}
	}
	_, err := w.WriteString(".\r\n")
	return err
}
