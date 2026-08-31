package harness

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Mismatch is one way a result disagreed with its expectation, tagged
// with which of the four assertion dimensions it came from.
//
// Evaluate returns these rather than calling t.Error itself, for one
// reason that matters more than tidiness: it makes "can this harness
// actually fail" a thing a test can assert. harness/selftest feeds
// Evaluate deliberately wrong expectations and checks that the right
// dimension goes red with a readable message. A harness that only ever
// reports failure by failing the test it is embedded in can never be
// shown to work, only observed not to complain.
type Mismatch struct {
	// Dimension is exit, stdout, stderr or state.
	Dimension string
	Message   string
}

func (m Mismatch) String() string { return m.Dimension + ": " + m.Message }

// Dimensions are the four independent things every case asserts. They are
// evaluated separately, and a case is required to say something about
// each one, so a regression cannot hide in the dimension nobody looked at.
var Dimensions = []string{"exit", "stdout", "stderr", "state"}

// Evaluate compares a result against its case.
func Evaluate(c Case, r Result) []Mismatch {
	var out []Mismatch
	out = append(out, evaluateExit(c, r)...)
	out = append(out, evaluateStream("stdout", c.Stdout, r.Norm.Lines(r.Stdout))...)
	out = append(out, evaluateStream("stderr", c.Stderr, r.Norm.Lines(r.Stderr))...)
	out = append(out, evaluateState(c, r)...)
	return out
}

func evaluateExit(c Case, r Result) []Mismatch {
	if r.Exit == c.Exit {
		return nil
	}
	return []Mismatch{{
		Dimension: "exit",
		Message: fmt.Sprintf("expected exit %d, got %d\n  argv: %v\n  stderr:\n%s",
			c.Exit, r.Exit, r.Argv, indentBlock(r.Norm.Lines(r.Stderr))),
	}}
}

func evaluateStream(dimension string, expect Stream, lines []string) []Mismatch {
	switch expect.Mode {
	case "ignored":
		return nil
	case "empty":
		if len(lines) == 0 {
			return nil
		}
		return []Mismatch{{
			Dimension: dimension,
			Message:   fmt.Sprintf("expected nothing on %s, got %d line(s):\n%s", dimension, len(lines), indentBlock(lines)),
		}}
	}

	var out []Mismatch
	for _, m := range expect.Matchers {
		if msg := m.check(dimension, lines); msg != "" {
			out = append(out, Mismatch{Dimension: dimension, Message: msg})
		}
	}
	return out
}

func (m Matcher) check(dimension string, lines []string) string {
	switch {
	case m.Line != "":
		re, err := compileLine(m.Line)
		if err != nil {
			return fmt.Sprintf("expectation %q is not a usable line pattern: %v", m.Line, err)
		}
		for _, l := range lines {
			if re.MatchString(l) {
				return ""
			}
		}
		return fmt.Sprintf("expected a line\n    %s\nbut %s had %d line(s):\n%s\n  (paths are shown tokenised; ${TS}, ${DUR}, ${INT}, ${SHA}, ${ANY} match any value)",
			m.Line, dimension, len(lines), indentBlock(lines))

	case m.Re != "":
		re, err := regexp.Compile("^" + m.Re + "$")
		if err != nil {
			return fmt.Sprintf("expectation regexp %q does not compile: %v", m.Re, err)
		}
		for _, l := range lines {
			if re.MatchString(l) {
				return ""
			}
		}
		return fmt.Sprintf("expected a line matching /%s/\nbut %s had %d line(s):\n%s", m.Re, dimension, len(lines), indentBlock(lines))

	case m.Contains != "":
		if strings.Contains(strings.Join(lines, "\n"), m.Contains) {
			return ""
		}
		return fmt.Sprintf("expected %s to contain\n    %s\nbut it was:\n%s", dimension, m.Contains, indentBlock(lines))

	case m.Absent != "":
		joined := strings.Join(lines, "\n")
		if !strings.Contains(joined, m.Absent) {
			return ""
		}
		var hits []string
		for _, l := range lines {
			if strings.Contains(l, m.Absent) {
				hits = append(hits, l)
			}
		}
		return fmt.Sprintf("expected %s never to mention\n    %s\nbut it appears on:\n%s", dimension, m.Absent, indentBlock(hits))

	case len(m.NDJSON) > 0:
		var parsed int
		for _, l := range lines {
			var obj map[string]any
			if json.Unmarshal([]byte(l), &obj) != nil {
				continue
			}
			parsed++
			if ndjsonMatches(obj, m.NDJSON) {
				return ""
			}
		}
		return fmt.Sprintf("expected an NDJSON line on %s carrying %v, but none of the %d parseable JSON line(s) matched:\n%s",
			dimension, m.NDJSON, parsed, indentBlock(lines))

	case m.Count != nil:
		if len(lines) == *m.Count {
			return ""
		}
		return fmt.Sprintf("expected %s to have exactly %d line(s), got %d:\n%s", dimension, *m.Count, len(lines), indentBlock(lines))
	}
	return "matcher asserts nothing"
}

// ndjsonMatches is a field-subset comparison: the observed event may
// carry any number of extra fields (and will, since FR-23 events grow
// over time), but every field the expectation names has to be there with
// that value. Values compare as text so an expectation does not have to
// guess whether a count came back as an int or a float.
func ndjsonMatches(obj map[string]any, want map[string]string) bool {
	for k, v := range want {
		got, ok := obj[k]
		if !ok {
			return false
		}
		if fmt.Sprintf("%v", got) != v {
			return false
		}
	}
	return true
}

func evaluateState(c Case, r Result) []Mismatch {
	var out []Mismatch
	switch c.State.Mode {
	case "ignored":
	case "unchanged":
		if !r.Diff.Empty() {
			out = append(out, Mismatch{
				Dimension: "state",
				Message:   "expected the work directory to be untouched, but it changed:\n" + indentBlock(strings.Split(r.Diff.String(), "\n")),
			})
		}
	case "changed":
		if r.Diff.Empty() {
			out = append(out, Mismatch{
				Dimension: "state",
				Message:   "expected the work directory to change, but nothing did",
			})
		}
	}

	for _, p := range c.State.FilesPresent {
		if present, isDB := dbPresence(r, p); isDB {
			if !present {
				out = append(out, Mismatch{Dimension: "state", Message: "expected the state database to exist afterwards, and it does not"})
			}
			continue
		}
		rel := relativeTo(r, p)
		if _, ok := r.After.Files[rel]; !ok {
			out = append(out, Mismatch{
				Dimension: "state",
				Message:   fmt.Sprintf("expected %s to exist afterwards; the work directory holds:\n%s", p, indentBlock(fileList(r))),
			})
		}
	}
	for _, p := range c.State.FilesAbsent {
		if present, isDB := dbPresence(r, p); isDB {
			if present {
				out = append(out, Mismatch{Dimension: "state", Message: "expected no state database afterwards, but one exists"})
			}
			continue
		}
		rel := relativeTo(r, p)
		if _, ok := r.After.Files[rel]; ok {
			out = append(out, Mismatch{
				Dimension: "state",
				Message:   fmt.Sprintf("expected %s not to exist afterwards, but it does", p),
			})
		}
	}
	return out
}

// relativeTo turns a ${WORK}-rooted token path into the work-relative key
// a snapshot uses. The state database is deliberately not part of the
// file half of a snapshot (statesnap compares it logically instead), so
// files_present/files_absent on ${STATE_DB} is answered from the logical
// dump's presence flag rather than from the file map.
func relativeTo(r Result, tokenPath string) string {
	abs := r.Norm.Expand(tokenPath)
	rel := strings.TrimPrefix(abs, r.Manifest.Work+"/")
	return rel
}

// dbPresence answers a files_present/files_absent claim about the state
// database from the logical dump rather than the file map, because
// statesnap deliberately keeps the database out of the byte-compared
// half of a snapshot.
func dbPresence(r Result, tokenPath string) (present, isDB bool) {
	if r.Norm.Expand(tokenPath) != r.Manifest.StateDB {
		return false, false
	}
	return r.After.DB.Present, true
}

func fileList(r Result) []string {
	var out []string
	for p := range r.After.Files {
		out = append(out, p)
	}
	if r.After.DB.Present {
		out = append(out, "(state database present)")
	} else {
		out = append(out, "(no state database)")
	}
	return out
}

func indentBlock(lines []string) string {
	if len(lines) == 0 {
		return "    (empty)"
	}
	const limit = 30
	shown := lines
	suffix := ""
	if len(shown) > limit {
		suffix = fmt.Sprintf("\n    ... and %d more line(s)", len(shown)-limit)
		shown = shown[:limit]
	}
	var b strings.Builder
	for i, l := range shown {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString("    " + l)
	}
	return b.String() + suffix
}
