package getbuild

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// VersionInfo is what `retnd version` reports, parsed.
type VersionInfo struct {
	BinaryVersion string
	Rclone        string
	Go            string
	Commit        string
	Raw           string
}

// Handshake makes the binary state its own identity and refuses the run
// unless it matches what the pin promised.
//
// This exists because "the harness was pointed at the right build" and
// "the harness tested the right build" are different claims, and this
// campaign has already had the second one turn out false: a Playwright
// control reported green against a stale dev server on a shared port,
// from an entirely different commit. A path on disk, a port number and a
// container name are all things that can be stale without looking stale.
// A commit the binary prints about itself is not.
//
// Every suite calls this before its first case, and a mismatch aborts
// rather than skipping, because a suite that quietly certifies an unknown
// build is worse than a suite that does not run.
func Handshake(b Build) (VersionInfo, error) {
	var stdout, stderr bytes.Buffer
	cmd := exec.Command(b.CLI, "version")
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return VersionInfo{}, fmt.Errorf("identity handshake: %s version failed: %w (stderr: %s)", b.CLI, err, strings.TrimSpace(stderr.String()))
	}

	info := parseVersion(stdout.String())
	if info.Commit == "" {
		return info, fmt.Errorf("identity handshake: %s version printed no commit line:\n%s", b.CLI, info.Raw)
	}
	if !commitsAgree(info.Commit, b.ExpectedCommit) {
		return info, fmt.Errorf(
			"identity handshake failed: the build under test reports commit %s but the pin (%s mode, %s) promised %s.\n"+
				"Refusing to run: a suite that certifies an unknown build certifies nothing.\nversion output:\n%s",
			info.Commit, b.Mode, b.Provenance, b.ExpectedCommit, info.Raw)
	}
	return info, nil
}

func parseVersion(out string) VersionInfo {
	info := VersionInfo{Raw: strings.TrimRight(out, "\n")}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		// Every spelling the product has ever printed, deliberately not
		// one. The command is `retnd` from EPIC R (backupd#885) on, was
		// `backupd` from backupd#794, `rbm` from 0.3.3, and
		// `backup-manager` before that; the pin is allowed to point at
		// any build across those lines, so this parser (which runs
		// before any case does) has to still say which commit an older
		// build is. The version command's own printed name is asserted
		// where an assertion belongs, in cases/version/happy.yaml, which
		// is a single spelling and goes red if the product prints a
		// different one.
		//
		// This is the one place in this repository where the retired
		// names are READ rather than referenced, and it is why the list
		// grows by one per rename instead of moving: a parser that only
		// knew the current name would abort the run on an older pin with
		// "no version line", which reads as a broken binary rather than
		// as an older one.
		case "retnd", "backupd", "rbm", "backup-manager":
			info.BinaryVersion = fields[1]
		case "rclone":
			info.Rclone = fields[1]
		case "go":
			info.Go = fields[1]
		case "commit":
			info.Commit = fields[1]
		}
	}
	return info
}

// commitsAgree compares two commit strings the way git itself lets a
// human compare them: either may be an abbreviation of the other, and a
// build made from a dirty tree may carry a -dirty suffix it did not get
// from the pin. Seven characters is the shortest abbreviation git will
// hand out, so anything shorter is treated as no answer at all.
func commitsAgree(observed, expected string) bool {
	o := strings.TrimSuffix(observed, "-dirty")
	e := strings.TrimSuffix(expected, "-dirty")
	if len(o) < 7 || len(e) < 7 {
		return false
	}
	return strings.HasPrefix(o, e) || strings.HasPrefix(e, o)
}

// RepoRoot walks up from start until it finds build-under-test.json, so a
// test can locate the pin regardless of which package directory `go test`
// happened to run it from.
func RepoRoot(start string) (string, error) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "build-under-test.json")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("no build-under-test.json above %s", start)
		}
		dir = parent
	}
}
