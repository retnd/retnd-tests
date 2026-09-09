package fixtures

import (
	"bytes"
	"fmt"
	"hash/fnv"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Manifest is what materialising a scenario produces: every absolute path
// a suite needs, plus a record of whatever replay was used to seed state.
//
// It is JSON-serialisable on purpose. Suite A consumes it as a Go value;
// the browser-driven suites will shell out to cmd/mkfixture and read the
// same structure off stdout, so all three suites agree on what a scenario
// is by construction rather than by three parallel implementations.
type Manifest struct {
	Scenario   string      `json:"scenario"`
	Work       string      `json:"work"`
	Config     string      `json:"config"`
	StateDir   string      `json:"state_dir"`
	StateDB    string      `json:"state_db"`
	RemoteRoot string      `json:"remote_root"`
	LocalRoot  string      `json:"local_root"`
	Sets       []SetPaths  `json:"sets"`
	Replay     []ReplayRun `json:"replay,omitempty"`
}

type SetPaths struct {
	Source     string `json:"source"`
	Set        string `json:"set"`
	ID         string `json:"id"`
	RemotePath string `json:"remote_path"`
	LocalPath  string `json:"local_path"`
}

// ReplayRun records one seeding invocation, so a scenario that failed to
// seed says so out loud instead of producing an empty catalog that a
// later case would read as a legitimate empty result.
type ReplayRun struct {
	Argv   []string `json:"argv"`
	Exit   int      `json:"exit"`
	Stdout string   `json:"stdout"`
	Stderr string   `json:"stderr"`
}

// Options controls one materialisation.
type Options struct {
	// Work is the directory to build into. It must already exist and
	// should be empty; a test's t.TempDir() is the intended caller.
	Work string
	// CLI is the rbm binary used for replay seeding. Required
	// when the scenario's state is "replay".
	CLI string
	// Now anchors every relative mtime. Zero means time.Now().
	Now time.Time
}

// Materialize builds a scenario into a work directory and returns its
// manifest.
func Materialize(s Scenario, opt Options) (Manifest, error) {
	now := opt.Now
	if now.IsZero() {
		now = time.Now()
	}
	work, err := filepath.Abs(opt.Work)
	if err != nil {
		return Manifest{}, err
	}
	// macOS hands out temp directories under /var, which is a symlink to
	// /private/var. The product prints whichever spelling it was given, so
	// the fixture resolves it once, here, and everything downstream (paths
	// in the config, path tokens in the normaliser) uses the resolved
	// form. Doing it anywhere later means two spellings of the same
	// directory and assertions that pass or fail by platform.
	if resolved, err := filepath.EvalSymlinks(work); err == nil {
		work = resolved
	}

	m := Manifest{
		Scenario:   s.Name,
		Work:       work,
		Config:     filepath.Join(work, "config.yaml"),
		StateDir:   filepath.Join(work, "state"),
		StateDB:    filepath.Join(work, "state", "state.db"),
		RemoteRoot: filepath.Join(work, "remote"),
		LocalRoot:  filepath.Join(work, "local"),
	}
	for _, d := range []string{m.StateDir, m.RemoteRoot, m.LocalRoot} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return m, err
		}
	}

	for _, src := range s.Sources {
		for _, bs := range src.BackupSets {
			paths := SetPaths{
				Source:     src.ID,
				Set:        bs.ID,
				ID:         src.ID + "/" + bs.ID,
				RemotePath: filepath.Join(m.RemoteRoot, src.ID, bs.ID),
				LocalPath:  filepath.Join(m.LocalRoot, src.ID, bs.ID),
			}
			if bs.RemotePath != "" {
				paths.RemotePath = expand(bs.RemotePath, m)
			}
			if bs.LocalPath != "" {
				paths.LocalPath = expand(bs.LocalPath, m)
			}
			m.Sets = append(m.Sets, paths)

			// Only directories this fixture actually owns get created. A
			// scenario that deliberately points at a missing directory
			// (the unreachable-remote family) keeps it missing.
			if bs.RemotePath == "" {
				if err := os.MkdirAll(paths.RemotePath, 0o755); err != nil {
					return m, err
				}
			}
			if bs.LocalPath == "" {
				if err := os.MkdirAll(paths.LocalPath, 0o755); err != nil {
					return m, err
				}
			}
			for _, a := range bs.Artifacts {
				if err := writeArtifact(paths.RemotePath, s.Name, paths.ID, a, now); err != nil {
					return m, err
				}
			}
		}
	}

	config := s.RawConfig
	if config == "" {
		config = renderConfig(s, m)
	} else {
		config = expand(config, m)
	}
	if err := os.WriteFile(m.Config, []byte(config), 0o644); err != nil {
		return m, err
	}

	switch s.State {
	case "none", "absent":
		// Nothing to do: the database does not exist, and the suite's
		// expectation is about what the binary does when it finds none.
	case "corrupt":
		// Garbage bytes, chosen so the file is plausibly sized and
		// definitely not a SQLite database. No schema knowledge involved,
		// which is exactly why this is the one pre-baked database fixture
		// that is allowed to exist.
		if err := os.WriteFile(m.StateDB, corruptBytes(), 0o644); err != nil {
			return m, err
		}
	case "replay":
		runs, err := replay(s, &m, opt)
		if err != nil {
			return m, err
		}
		m.Replay = runs
	}
	return m, nil
}

// replay seeds the catalog by running documented operator commands
// against the fixture, and refuses to hand back a manifest whose seeding
// failed. An empty catalog produced by a broken replay looks exactly like
// an empty catalog produced by a correct one, and every case downstream
// would then be asserting against a situation nobody meant to create.
func replay(s Scenario, m *Manifest, opt Options) ([]ReplayRun, error) {
	if opt.CLI == "" {
		return nil, fmt.Errorf("scenario %q seeds by replay but no CLI binary was provided", s.Name)
	}
	var runs []ReplayRun
	for _, set := range m.Sets {
		var argv []string
		switch s.Replay {
		case "fetch":
			argv = []string{"fetch", "--config", m.Config, "--source", set.Source, "--backup-set", set.Set}
		case "run":
			argv = []string{"run", "--config", m.Config}
		default:
			return nil, fmt.Errorf("scenario %q: unsupported replay command %q (expected fetch or run)", s.Name, s.Replay)
		}

		var stdout, stderr bytes.Buffer
		cmd := exec.Command(opt.CLI, argv...)
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		cmd.Env = append(os.Environ(), "TZ=UTC")
		err := cmd.Run()
		run := ReplayRun{Argv: argv, Stdout: stdout.String(), Stderr: stderr.String()}
		if exitErr, ok := err.(*exec.ExitError); ok {
			run.Exit = exitErr.ExitCode()
		} else if err != nil {
			return nil, fmt.Errorf("replaying %v: %w", argv, err)
		}
		runs = append(runs, run)
		if run.Exit != 0 {
			return nil, fmt.Errorf("scenario %q: replay %v exited %d, so the fixture was never seeded.\nstderr:\n%s\nstdout:\n%s",
				s.Name, argv, run.Exit, run.Stderr, run.Stdout)
		}
		if s.Replay == "run" {
			// `run` covers every backup set in one cycle, so replaying it
			// per set would seed the same state several times over.
			break
		}
	}
	return runs, nil
}

func writeArtifact(dir, scenario, setID string, a Artifact, now time.Time) error {
	if a.Name == "" {
		return fmt.Errorf("scenario %s: backup set %s has an artifact with no name", scenario, setID)
	}
	size := a.Size
	if size == 0 {
		size = 4096
	}
	h := fnv.New64a()
	fmt.Fprintf(h, "%s\x00%s\x00%s\x00%s", scenario, setID, a.Name, a.Seed)
	buf := make([]byte, size)
	rand.New(rand.NewSource(int64(h.Sum64()))).Read(buf)

	path := filepath.Join(dir, a.Name)
	if err := os.WriteFile(path, buf, 0o644); err != nil {
		return err
	}
	mt, err := parseOffset(a.MTime, now)
	if err != nil {
		return fmt.Errorf("scenario %s, artifact %s: %w", scenario, a.Name, err)
	}
	return os.Chtimes(path, mt, mt)
}

func corruptBytes() []byte {
	b := make([]byte, 8192)
	rand.New(rand.NewSource(0x5EEDC0FFEE)).Read(b)
	// Make the damage self-describing when a human opens the file, and
	// make sure the first sixteen bytes are not SQLite's magic header.
	copy(b, []byte("NOT-A-SQLITE-DB "))
	return b
}

func expand(s string, m Manifest) string {
	r := strings.NewReplacer(
		"${WORK}", m.Work,
		"${CONFIG}", m.Config,
		"${STATE_DIR}", m.StateDir,
		"${STATE_DB}", m.StateDB,
		"${REMOTE}", m.RemoteRoot,
		"${LOCAL}", m.LocalRoot,
	)
	return r.Replace(s)
}

// renderConfig writes the FR-5 config file for a scenario.
//
// This is hand-rendered text rather than a marshalled struct because the
// config file is part of the contract under test: an operator writes YAML
// by hand against docs/EPIC.md's FR-5 example, and so does this.
func renderConfig(s Scenario, m Manifest) string {
	var b strings.Builder
	fmt.Fprintf(&b, "poll_interval: %s\n", s.PollInterval)
	b.WriteString("state:\n")
	fmt.Fprintf(&b, "  database: %s\n", m.StateDB)
	b.WriteString("sources:\n")
	i := 0
	for _, src := range s.Sources {
		fmt.Fprintf(&b, "  - id: %s\n", src.ID)
		b.WriteString("    backup_sets:\n")
		for _, bs := range src.BackupSets {
			paths := m.Sets[i]
			i++
			fmt.Fprintf(&b, "      - id: %s\n", bs.ID)
			b.WriteString("        remote:\n")
			remoteType := bs.Remote.Type
			if remoteType == "" {
				remoteType = "local"
			}
			fmt.Fprintf(&b, "          type: %s\n", remoteType)
			fmt.Fprintf(&b, "        remote_path: %s\n", paths.RemotePath)
			fmt.Fprintf(&b, "        local_path: %s\n", paths.LocalPath)
			if len(bs.Include) > 0 {
				b.WriteString("        include:\n")
				for _, pat := range bs.Include {
					fmt.Fprintf(&b, "          - %q\n", pat)
				}
			}
			b.WriteString("        completion:\n")
			strategy := bs.Completion.Strategy
			if strategy == "" {
				strategy = "rename"
			}
			fmt.Fprintf(&b, "          strategy: %s\n", strategy)
			if bs.Completion.StableFor != "" {
				fmt.Fprintf(&b, "          stable_for: %s\n", bs.Completion.StableFor)
			}
			staleAfter := bs.StaleAfter
			if staleAfter == "" {
				staleAfter = "30h"
			}
			fmt.Fprintf(&b, "        stale_after: %s\n", staleAfter)
			if bs.Validation != nil {
				b.WriteString("        validation:\n")
				fmt.Fprintf(&b, "          hash: %s\n", bs.Validation.Hash)
			}
		}
	}
	r := s.Retention
	if r == nil {
		yes := true
		r = &Retention{Timezone: "UTC", WeekStartsOn: "monday", DailyDays: 7, WeeklyMonths: 3, MonthlyMonths: 12, ProtectLastKnownGood: &yes}
	}
	b.WriteString("retention:\n")
	fmt.Fprintf(&b, "  timezone: %s\n", r.Timezone)
	fmt.Fprintf(&b, "  week_starts_on: %s\n", r.WeekStartsOn)
	if r.DailyDays != 0 {
		fmt.Fprintf(&b, "  daily_days: %d\n", r.DailyDays)
	}
	if r.WeeklyMonths != 0 {
		fmt.Fprintf(&b, "  weekly_months: %d\n", r.WeeklyMonths)
	}
	if r.MonthlyMonths != 0 {
		fmt.Fprintf(&b, "  monthly_months: %d\n", r.MonthlyMonths)
	}
	if r.ProtectLastKnownGood != nil {
		fmt.Fprintf(&b, "  protect_last_known_good: %t\n", *r.ProtectLastKnownGood)
	}
	return b.String()
}
