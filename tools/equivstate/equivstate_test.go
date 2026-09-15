package equivstate_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/backupdproject/backupd-tests/tools/equivstate"
)

// The point of these tests is the RED half of Suite C's plan: a state
// differ nobody has seen fail is not a state differ. Each case that
// asserts "these two agree" is paired with one that makes the same
// comparison disagree by changing exactly one thing.

func TestCompare_IdenticalDirectoriesAgree(t *testing.T) {
	a, b := pair(t, nil)
	res := compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "same")})
	if !res.Equal() {
		t.Fatalf("two identical work directories were reported as different:\n%s", equivstate.Render(res))
	}
}

func TestCompare_AChangedFileIsDetected(t *testing.T) {
	a, b := pair(t, nil)
	write(t, filepath.Join(b, "local", "set", "artifact.dump"), "different bytes")

	res := compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "same")})
	if res.Equal() {
		t.Fatal("a changed artifact was not detected, so every 'they agree' result in this suite means nothing")
	}
	if !strings.Contains(equivstate.Render(res), "artifact.dump") {
		t.Fatalf("the report does not name the file that differs:\n%s", equivstate.Render(res))
	}
}

func TestCompare_AFileOnlyOneSideHasIsDetected(t *testing.T) {
	a, b := pair(t, nil)
	write(t, filepath.Join(b, "local", "set", "extra.dump"), "only here")

	res := compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "same")})
	if res.Equal() {
		t.Fatal("a file present on one side only was not detected")
	}
}

// The ignore list has to be honest in both directions: it must actually
// suppress what it names, and it must name what it suppressed, so a
// comparison cannot quietly ignore the thing under test.
func TestCompare_IgnoredFilesAreSuppressedAndReported(t *testing.T) {
	a, b := pair(t, nil)
	write(t, filepath.Join(b, "config.yaml"), "written by a different writer\n")

	res := compare(t, a, b, equivstate.Options{
		CLI:         stubCLI(t, "same"),
		IgnoreFiles: []string{"config.yaml"},
	})
	if !res.Equal() {
		t.Fatalf("an ignored file still failed the comparison:\n%s", equivstate.Render(res))
	}
	if len(res.IgnoredHit) == 0 {
		t.Fatal("the comparison ignored a file without saying which, so the ignore list cannot be reviewed")
	}

	// The control: without the ignore, the same pair differs.
	again := compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "same")})
	if again.Equal() {
		t.Fatal("the same pair agreed with no ignore list, so the previous case proved nothing")
	}
}

func TestCompare_ADifferentReadSurfaceIsDetected(t *testing.T) {
	a, b := pair(t, nil)
	res := compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "per-config")})
	if res.Equal() {
		t.Fatal("two sides whose read commands print different things were reported as equal")
	}
	if !strings.Contains(equivstate.Render(res), "differs between the two sides") {
		t.Fatalf("the report does not say which read command differs:\n%s", equivstate.Render(res))
	}
}

func TestCompare_MaskingHidesTimestampsAndOnlyTimestamps(t *testing.T) {
	a, b := pair(t, nil)

	unmasked := compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "timestamps")})
	if unmasked.Equal() {
		t.Fatal("two sides printing different timestamps were reported as equal without masking, so the mask proves nothing")
	}

	masked := compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "timestamps"), MaskVolatile: true})
	if !masked.Equal() {
		t.Fatalf("masking did not absorb a timestamp-only difference:\n%s", equivstate.Render(masked))
	}

	// And the mask must not swallow a real difference that happens to sit
	// on a line with a timestamp on it.
	real := compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "timestamps-and-a-real-difference"), MaskVolatile: true})
	if real.Equal() {
		t.Fatal("masking timestamps also hid a real difference on the same line")
	}
}

func TestCompare_VolatileOnlyFileDifferencesAreForgivenAndNamed(t *testing.T) {
	a, b := pair(t, nil)
	// A sidecar manifest: same facts, different ingest timestamp. This is
	// the real shape, not a contrived one; the fixture layer's own
	// recovery manifests differ exactly this way between two runs.
	write(t, filepath.Join(a, "local", "set", "artifact.dump.manifest.json"),
		`{"sha256":"abc","ingested_at":"2026-08-31T04:05:06Z"}`)
	write(t, filepath.Join(b, "local", "set", "artifact.dump.manifest.json"),
		`{"sha256":"abc","ingested_at":"2026-08-31T09:10:11Z"}`)

	unmasked := compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "same")})
	if unmasked.Equal() {
		t.Fatal("two sidecars with different bytes were reported as equal without masking, so the mask proves nothing")
	}

	masked := compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "same"), MaskVolatile: true})
	if !masked.Equal() {
		t.Fatalf("a timestamp-only sidecar difference was not forgiven:\n%s", equivstate.Render(masked))
	}
	if len(masked.MaskedFiles) == 0 {
		t.Fatal("the comparison forgave a file without naming it, so what it forgave cannot be reviewed")
	}

	// And the control that matters most: a REAL difference in the same
	// file, alongside a timestamp difference, must survive the mask.
	write(t, filepath.Join(b, "local", "set", "artifact.dump.manifest.json"),
		`{"sha256":"DIFFERENT","ingested_at":"2026-08-31T09:10:11Z"}`)
	real := compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "same"), MaskVolatile: true})
	if real.Equal() {
		t.Fatal("masking timestamps inside a sidecar also hid a changed digest recorded in it")
	}
}

func TestCompare_TheRunsOwnDirectoryIsForgivenButThePathUnderItIsNot(t *testing.T) {
	a, b := pair(t, nil)
	// The shape that made specs/backup-set-create.spec.ts unpassable. A
	// sidecar records its artifact's location as an ABSOLUTE path, so the
	// two sides record the two temporary directories they each ran in.
	// Those names are not the same length either, so it also reads as a
	// size change, which is how it came to look like a real difference in
	// what the API and the CLI wrote.
	write(t, filepath.Join(a, "local", "set", "artifact.dump.manifest.json"),
		`{"sha256":"abc","copies":[{"location":"`+a+`/local/set/artifact.dump"}]}`)
	write(t, filepath.Join(b, "local", "set", "artifact.dump.manifest.json"),
		`{"sha256":"abc","copies":[{"location":"`+b+`/local/set/artifact.dump"}]}`)

	unmasked := compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "same")})
	if unmasked.Equal() {
		t.Fatal("two sidecars recording different absolute locations compared equal without masking, so the mask below proves nothing")
	}

	masked := compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "same"), MaskVolatile: true})
	if !masked.Equal() {
		t.Fatalf("a location difference that is only the run's own directory was not forgiven:\n%s", equivstate.Render(masked))
	}

	// The control, and the reason this masks the root rather than the
	// whole path: a location that differs BENEATH the root is a real
	// difference in where the product put the file, and forgiving that
	// would turn this comparison into a formality.
	write(t, filepath.Join(b, "local", "set", "artifact.dump.manifest.json"),
		`{"sha256":"abc","copies":[{"location":"`+b+`/local/SOMEWHERE-ELSE/artifact.dump"}]}`)
	real := compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "same"), MaskVolatile: true})
	if real.Equal() {
		t.Fatal("masking the run's own directory also hid a path difference under it, so a product that filed an artifact somewhere else would compare equal")
	}
}

func TestCompare_FreeSpaceIsMaskedButSizesAreNot(t *testing.T) {
	a, b := pair(t, nil)

	// The host's free space changes between two consecutive invocations
	// and is not backend state at all.
	if !compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "free-space"), MaskVolatile: true}).Equal() {
		t.Fatal("a differing free-space reading failed the comparison even with masking on")
	}
	// An artifact size is contractual and must never be masked.
	if compare(t, a, b, equivstate.Options{CLI: stubCLI(t, "artifact-size"), MaskVolatile: true}).Equal() {
		t.Fatal("a differing artifact size was masked away, so the mask is too wide to trust")
	}
}

// ------------------------------------------------------------- helpers

func compare(t *testing.T, a, b string, o equivstate.Options) equivstate.Result {
	t.Helper()
	o.A, o.B = a, b
	res, err := equivstate.Compare(o)
	if err != nil {
		t.Fatalf("Compare: %v", err)
	}
	return res
}

// pair builds two work directories with identical content.
func pair(t *testing.T, _ any) (string, string) {
	t.Helper()
	root := t.TempDir()
	var dirs [2]string
	for i, name := range []string{"a", "b"} {
		dir := filepath.Join(root, name)
		write(t, filepath.Join(dir, "config.yaml"), "poll_interval: 15m\n")
		write(t, filepath.Join(dir, "local", "set", "artifact.dump"), "identical bytes")
		write(t, filepath.Join(dir, "remote", "set", "artifact.dump"), "identical bytes")
		dirs[i] = dir
	}
	return dirs[0], dirs[1]
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// stubCLI writes a script that stands in for retnd. Each mode
// decides how the two sides' read surfaces relate, which is the one
// variable each test above is changing.
func stubCLI(t *testing.T, mode string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the stub CLI is a shell script")
	}
	body := map[string]string{
		"same":                             `echo "sets: 2"`,
		"per-config":                       `echo "sets: $(basename "$(dirname "$3")")"`,
		"timestamps":                       `echo "last run 2026-08-$(( $(basename "$(dirname "$3")" | tr 'ab' '12') + 10 ))T04:05:06Z"`,
		"timestamps-and-a-real-difference": `echo "last run 2026-08-$(( $(basename "$(dirname "$3")" | tr 'ab' '12') + 10 ))T04:05:06Z, sets $(basename "$(dirname "$3")")"`,
		"free-space":                       `echo "  free space: $(( $(basename "$(dirname "$3")" | tr 'ab' '12') + 1000 )) bytes"`,
		"artifact-size":                    `echo "  pg.dump $(( $(basename "$(dirname "$3")" | tr 'ab' '12') + 1000 )) bytes"`,
	}[mode]
	if body == "" {
		t.Fatalf("unknown stub mode %q", mode)
	}
	path := filepath.Join(t.TempDir(), "retnd")
	write(t, path, "#!/bin/sh\n"+body+"\n")
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}
