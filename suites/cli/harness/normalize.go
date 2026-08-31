package harness

import (
	"os"
	"regexp"
	"strings"

	fixtures "github.com/spdrman/rclone-manager-tests/fixtures/lib"
)

// Normalizer rewrites machine-specific text out of a command's output,
// and expands the same tokens back into real values for argv.
//
// It normalises exactly one class of thing: absolute paths that only
// exist on the machine running the suite, plus the hostname. Everything
// else that varies between runs (timestamps, durations, digests, counts
// nobody documented) is handled in the other direction, by writing a
// ${TS} or ${DUR} token into the expectation itself. That asymmetry is
// deliberate. A normaliser that quietly rewrites timestamps out of every
// line also quietly rewrites them out of the one line where the
// timestamp was the point, and nobody notices until it matters; a token
// in an expectation is visible to whoever reads the case.
type Normalizer struct {
	pathReplacer *strings.Replacer
	expander     *strings.Replacer
	hostname     string
}

// NewNormalizer builds a normaliser for one materialised fixture.
func NewNormalizer(m fixtures.Manifest) *Normalizer {
	// Longest first: ${STATE_DB} lives under ${STATE_DIR}, which lives
	// under ${WORK}, so replacing ${WORK} first would leave nothing for
	// the more specific tokens to match.
	pairs := []string{
		m.Config, "${CONFIG}",
		m.StateDB, "${STATE_DB}",
		m.StateDir, "${STATE_DIR}",
		m.RemoteRoot, "${REMOTE}",
		m.LocalRoot, "${LOCAL}",
		m.Work, "${WORK}",
	}
	expand := []string{
		"${CONFIG}", m.Config,
		"${STATE_DB}", m.StateDB,
		"${STATE_DIR}", m.StateDir,
		"${REMOTE}", m.RemoteRoot,
		"${LOCAL}", m.LocalRoot,
		"${WORK}", m.Work,
	}
	host, _ := os.Hostname()
	return &Normalizer{
		pathReplacer: strings.NewReplacer(pairs...),
		expander:     strings.NewReplacer(expand...),
		hostname:     host,
	}
}

// Line normalises one line of observed output.
func (n *Normalizer) Line(s string) string {
	s = n.pathReplacer.Replace(s)
	if n.hostname != "" {
		s = strings.ReplaceAll(s, n.hostname, "${HOST}")
	}
	return s
}

// Lines normalises a whole stream, dropping the trailing empty line a
// stream ending in a newline always produces.
func (n *Normalizer) Lines(s string) []string {
	raw := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	out := make([]string, 0, len(raw))
	for _, l := range raw {
		out = append(out, n.Line(l))
	}
	for len(out) > 0 && strings.TrimSpace(out[len(out)-1]) == "" {
		out = out[:len(out)-1]
	}
	return out
}

// Expand turns tokens back into real paths, for argv and for the
// files_present/files_absent lists.
func (n *Normalizer) Expand(s string) string {
	return n.expander.Replace(s)
}

// valueTokens are the stand-ins an expectation may use for the parts of a
// line that are real output but not contractual values. Each one is a
// regular expression fragment; a `line:` matcher is escaped and then has
// these substituted, so the rest of the line stays an exact match.
var valueTokens = []struct {
	token   string
	pattern string
}{
	{"${TS}", `\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?`},
	{"${DUR}", `(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+`},
	{"${INT}", `\d+`},
	{"${SHA}", `[0-9a-f]{7,64}`},
	{"${SEMVER}", `v?\d+\.\d+\.\d+\S*`},
	{"${HOSTNAME}", `\S+`},
	{"${ANY}", `.*`},
	// Column padding. Several read commands align their output with
	// fixed-width fields, so the number of spaces between two columns is
	// a rendering detail and not something an expectation should pin.
	{"${SP}", `[ \t]+`},
}

// compileLine turns a `line:` expectation into an anchored regex.
func compileLine(expected string) (*regexp.Regexp, error) {
	const sep = "\x00"
	marked := expected
	for i, vt := range valueTokens {
		marked = strings.ReplaceAll(marked, vt.token, sep+string(rune('0'+i))+sep)
	}
	quoted := regexp.QuoteMeta(marked)
	for i, vt := range valueTokens {
		quoted = strings.ReplaceAll(quoted, regexp.QuoteMeta(sep+string(rune('0'+i))+sep), vt.pattern)
	}
	return regexp.Compile("^" + quoted + "$")
}
