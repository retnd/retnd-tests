// Package getbuild resolves the rclone-manager build that a suite run
// tests against, from the single checked-in pin in build-under-test.json.
//
// The point of the pin is that "which build did this suite certify" is a
// property of the repository, not of whoever happened to run it. Every
// mode below therefore ends in the same place: a Build value naming an
// absolute path to a backup-manager binary plus the commit that binary is
// supposed to have been built from. The suites then make the binary prove
// that claim itself (see Handshake), because a path on disk is not
// evidence of provenance.
package getbuild

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Pin is the parsed build-under-test.json.
type Pin struct {
	// Mode is source, registry or local. See the package doc and
	// docs/pinning.md for what each one promises.
	Mode string `json:"mode"`
	// Commit is the full rclone-manager sha the build must report.
	Commit string `json:"commit"`
	// Version is what the build's -X main.version was set to. Informational
	// in every mode; the commit is what the handshake checks.
	Version string `json:"version"`
	// SourceBuilder selects how source mode turns a checkout into binaries:
	// "go" compiles ./cmd/backup-manager directly (seconds, and enough for
	// the CLI contract), "docker" builds container/Dockerfile and extracts
	// /backup-manager from the image operators actually receive.
	SourceBuilder string `json:"source_builder"`
	Image         string `json:"image"`
	Notes         string `json:"notes"`
}

// Build is a resolved build under test.
type Build struct {
	// CLI is the absolute path to the backup-manager binary.
	CLI string
	// Web is the absolute path to backup-manager-web, empty when the
	// resolution route did not produce one (go-builder source mode does
	// not, since Suite A never needs it).
	Web string
	// ExpectedCommit is what Handshake requires the binary to report.
	ExpectedCommit string
	// Mode records which route produced this, for run provenance.
	Mode string
	// Provenance is a one-line human description of where it came from.
	Provenance string
}

// DefaultRepoURL is where source mode clones rclone-manager from when
// RM_SOURCE_REPO does not override it. A local checkout path works there
// too and is much faster, which is what the gate scripts use.
const DefaultRepoURL = "https://github.com/spdrman/rclone-manager.git"

// LoadPin reads build-under-test.json from repoRoot.
func LoadPin(repoRoot string) (Pin, error) {
	var p Pin
	raw, err := os.ReadFile(filepath.Join(repoRoot, "build-under-test.json"))
	if err != nil {
		return p, fmt.Errorf("reading the pin: %w", err)
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, fmt.Errorf("parsing build-under-test.json: %w", err)
	}
	switch p.Mode {
	case "source", "registry", "local":
	case "":
		return p, errors.New("build-under-test.json: mode must be set (source, registry or local)")
	default:
		return p, fmt.Errorf("build-under-test.json: unsupported mode %q (expected source, registry or local)", p.Mode)
	}
	return p, nil
}

// Resolve turns a pin plus the environment into a usable Build.
//
// Environment overrides, all documented in docs/pinning.md:
//
//	RM_MODE          force a mode, ignoring the pin's own
//	RM_BINARY        local mode: the backup-manager binary to test
//	RM_WEB_BINARY    local mode: the backup-manager-web binary, optional
//	RM_COMMIT        local mode: the commit that binary claims to be
//	RM_SOURCE_DIR    local mode: a checkout to read HEAD from when RM_COMMIT is unset
//	RM_SOURCE_REPO   source mode: clone from here instead of DefaultRepoURL
//	RM_CACHE_DIR     where source mode keeps checkouts and built binaries
func Resolve(repoRoot string, pin Pin) (Build, error) {
	mode := pin.Mode
	if override := os.Getenv("RM_MODE"); override != "" {
		mode = override
	}
	switch mode {
	case "local":
		return resolveLocal()
	case "source":
		return resolveSource(pin)
	case "registry":
		return Build{}, errors.New(
			"registry mode is not usable yet: nothing has been pushed to ghcr.io/spdrman/backup-manager. " +
				"See docs/pinning.md; use source or local mode until the first push exists")
	default:
		return Build{}, fmt.Errorf("unsupported mode %q", mode)
	}
}

func resolveLocal() (Build, error) {
	bin := os.Getenv("RM_BINARY")
	if bin == "" {
		return Build{}, errors.New("local mode needs RM_BINARY pointing at a backup-manager binary")
	}
	abs, err := filepath.Abs(bin)
	if err != nil {
		return Build{}, err
	}
	if _, err := os.Stat(abs); err != nil {
		return Build{}, fmt.Errorf("RM_BINARY: %w", err)
	}

	commit := os.Getenv("RM_COMMIT")
	if commit == "" {
		if dir := os.Getenv("RM_SOURCE_DIR"); dir != "" {
			out, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
			if err != nil {
				return Build{}, fmt.Errorf("reading HEAD from RM_SOURCE_DIR %s: %w", dir, err)
			}
			commit = strings.TrimSpace(string(out))
		}
	}
	// Refusing here rather than skipping the handshake is deliberate. An
	// unverifiable build is the exact condition that let a green run be
	// reported against a stale process from a different commit, so "I do
	// not know what this binary is" has to stop the run, not relax it.
	if commit == "" {
		return Build{}, errors.New(
			"local mode needs the commit the binary claims to be: set RM_COMMIT, or RM_SOURCE_DIR to a checkout whose HEAD it was built from")
	}

	web, _ := filepath.Abs(os.Getenv("RM_WEB_BINARY"))
	if os.Getenv("RM_WEB_BINARY") == "" {
		web = ""
	}
	return Build{
		CLI:            abs,
		Web:            web,
		ExpectedCommit: commit,
		Mode:           "local",
		Provenance:     "local override RM_BINARY=" + abs,
	}, nil
}

func resolveSource(pin Pin) (Build, error) {
	if len(pin.Commit) < 7 {
		return Build{}, errors.New("source mode needs a full commit sha in build-under-test.json")
	}
	builder := pin.SourceBuilder
	if builder == "" {
		builder = "go"
	}

	cache := cacheDir()
	checkout := filepath.Join(cache, "src", pin.Commit)
	if err := ensureCheckout(checkout, pin.Commit); err != nil {
		return Build{}, err
	}

	binDir := filepath.Join(cache, "bin", builder, pin.Commit)
	cli := filepath.Join(binDir, "backup-manager")
	web := ""

	switch builder {
	case "go":
		if _, err := os.Stat(cli); err != nil {
			if err := os.MkdirAll(binDir, 0o755); err != nil {
				return Build{}, err
			}
			version := pin.Version
			if version == "" {
				version = pin.Commit[:7]
			}
			cmd := exec.Command("go", "build",
				"-ldflags", fmt.Sprintf("-X main.version=%s -X main.commit=%s", version, pin.Commit),
				"-o", cli, "./cmd/backup-manager")
			cmd.Dir = filepath.Join(checkout, "core")
			// The checkout has its own go.work, and this process may have
			// been started with a GOFLAGS the product's module does not
			// accept. Both are scrubbed so the build under test is decided
			// by the pinned source and nothing else: whatever resolved the
			// tests repository's own dependencies must not leak into it.
			cmd.Env = append(os.Environ(), "GOFLAGS=", "GOWORK=off")
			cmd.Stderr = os.Stderr
			if err := cmd.Run(); err != nil {
				return Build{}, fmt.Errorf("building backup-manager from %s: %w", checkout, err)
			}
		}
	case "docker":
		var err error
		cli, web, err = dockerBuild(checkout, binDir, pin)
		if err != nil {
			return Build{}, err
		}
	default:
		return Build{}, fmt.Errorf("unsupported source_builder %q (expected go or docker)", builder)
	}

	return Build{
		CLI:            cli,
		Web:            web,
		ExpectedCommit: pin.Commit,
		Mode:           "source",
		Provenance:     fmt.Sprintf("built from %s at %s with the %s builder", sourceRepo(), pin.Commit, builder),
	}, nil
}

// dockerBuild builds container/Dockerfile and copies both binaries out of
// the resulting image, so a run can test the artifact operators actually
// receive rather than a host compile of the same source.
func dockerBuild(checkout, binDir string, pin Pin) (cli, web string, err error) {
	cli = filepath.Join(binDir, "backup-manager")
	web = filepath.Join(binDir, "backup-manager-web")
	if _, statErr := os.Stat(cli); statErr == nil {
		if _, statErr := os.Stat(web); statErr == nil {
			return cli, web, nil
		}
	}
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return "", "", err
	}

	tag := "rclone-manager-tests/but:" + pin.Commit[:12]
	version := pin.Version
	if version == "" {
		version = pin.Commit[:7]
	}
	build := exec.Command("docker", "build",
		"-f", "container/Dockerfile",
		"--build-arg", "VERSION="+version,
		"--build-arg", "COMMIT="+pin.Commit,
		"-t", tag, ".")
	build.Dir = checkout
	build.Stdout, build.Stderr = os.Stderr, os.Stderr
	if err := build.Run(); err != nil {
		return "", "", fmt.Errorf("docker build of %s: %w", checkout, err)
	}

	created, err := exec.Command("docker", "create", tag).Output()
	if err != nil {
		return "", "", fmt.Errorf("docker create %s: %w", tag, err)
	}
	container := strings.TrimSpace(string(created))
	defer func() { _ = exec.Command("docker", "rm", "-f", container).Run() }()

	for src, dst := range map[string]string{"/backup-manager": cli, "/backup-manager-web": web} {
		cp := exec.Command("docker", "cp", container+":"+src, dst)
		cp.Stderr = os.Stderr
		if err := cp.Run(); err != nil {
			return "", "", fmt.Errorf("docker cp %s: %w", src, err)
		}
	}
	return cli, web, nil
}

func sourceRepo() string {
	if v := os.Getenv("RM_SOURCE_REPO"); v != "" {
		return v
	}
	return DefaultRepoURL
}

func cacheDir() string {
	if v := os.Getenv("RM_CACHE_DIR"); v != "" {
		return v
	}
	if v := os.Getenv("XDG_CACHE_HOME"); v != "" {
		return filepath.Join(v, "rclone-manager-tests")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cache", "rclone-manager-tests")
}

// ensureCheckout makes dir a checkout of exactly commit, cloning it on
// first use and leaving it alone afterwards. The directory is keyed by
// commit, so it is immutable once populated and two runs of different
// pins never fight over one working tree.
//
// The clone lands in a sibling scratch directory and is renamed into
// place only once it is complete, so a half-finished or interrupted
// fetch can never be mistaken for a good checkout. A failed attempt is
// left where it is rather than deleted: this path runs outside any
// workspace directory, and leaking one scratch directory is a much
// cheaper mistake than a recursive delete under someone's cache.
func ensureCheckout(dir, commit string) error {
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	scratch, err := os.MkdirTemp(filepath.Dir(dir), "partial-"+commit[:7]+"-")
	if err != nil {
		return err
	}
	repo := sourceRepo()
	steps := [][]string{
		{"git", "-C", scratch, "init", "--quiet"},
		{"git", "-C", scratch, "remote", "add", "origin", repo},
		{"git", "-C", scratch, "fetch", "--quiet", "--depth", "1", "origin", commit},
		{"git", "-C", scratch, "checkout", "--quiet", "FETCH_HEAD"},
	}
	for _, s := range steps {
		cmd := exec.Command(s[0], s[1:]...)
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("preparing a checkout of %s from %s (scratch left at %s): %w", commit, repo, scratch, err)
		}
	}
	if err := os.Rename(scratch, dir); err != nil {
		// Another run won the race and populated it first; theirs is the
		// same immutable commit, so use it.
		if _, statErr := os.Stat(filepath.Join(dir, ".git")); statErr == nil {
			return nil
		}
		return err
	}
	return nil
}
