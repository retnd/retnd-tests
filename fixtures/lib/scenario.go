// Package fixtures builds the backend state every suite in this
// repository tests against, from declarative scenario files under
// fixtures/scenarios.
//
// Two rules shape everything here, and both are about staying an outside
// consumer of retnd rather than an insider:
//
// First, nothing in this package imports anything from retnd.
// The tests repository has exactly what an operator has: a binary, a YAML
// config file, a state directory, and directory trees. The moment it
// imports the product's own packages it stops being able to catch the
// contract breaks it exists to catch, because it would be checking the
// product against itself.
//
// Second, catalog state is seeded by replaying documented operator
// commands, never by writing rows into SQLite. Writing rows would bake
// FR-9's schema into the fixtures, which is knowledge an operator does
// not have, and it would rot silently on the first schema migration. The
// only pre-baked database fixtures are the deliberately corrupt ones,
// which need no schema knowledge at all because they are garbage bytes.
//
// Seeding by replay does not smuggle the change-detector trap back in.
// Replay only sets the stage; every expectation a suite asserts still
// comes from the documented contract, and a case file that disagrees with
// observed behaviour is a finding to file, not a fixture to adjust.
package fixtures

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Scenario is one fixture definition, read from
// fixtures/scenarios/<name>/scenario.yaml.
type Scenario struct {
	// Name is filled in from the directory name, not the file.
	Name string `yaml:"-"`

	PollInterval string     `yaml:"poll_interval"`
	Retention    *Retention `yaml:"retention"`
	Sources      []Source   `yaml:"sources"`

	// State decides what the state database looks like before the first
	// command under test runs:
	//
	//	none    the database file does not exist and nothing seeds it
	//	absent  same file-system result as none, named separately because
	//	        the cases that use it are about a missing database rather
	//	        than about a fresh install
	//	replay  run Replay (default: fetch, per backup set) so the catalog
	//	        holds real rows a real cycle produced
	//	corrupt the file exists and is not a SQLite database
	State string `yaml:"state"`

	// Replay names the command replayed to seed state, when State is
	// "replay". Only "fetch" and "run" are meaningful; both are documented
	// operator commands, which is the whole point.
	Replay string `yaml:"replay"`

	// RawConfig, when set, is written to config.yaml verbatim instead of a
	// rendered config, after ${WORK}, ${STATE_DB}, ${REMOTE} and ${LOCAL}
	// substitution. This is how the malformed-YAML and failed-validation
	// scenarios express themselves without contorting the schema that
	// every valid scenario shares.
	RawConfig string `yaml:"raw_config"`

	// ExtraConfig is appended to the rendered config.yaml, after ${WORK},
	// ${STATE_DB}, ${REMOTE} and ${LOCAL} substitution. It is for the keys
	// the rendered shape has no field for (a workflows root, say) on a
	// scenario that otherwise wants the rendered sources. A scenario using
	// RawConfig writes its own keys and does not need it.
	ExtraConfig string `yaml:"extra_config"`

	// Files are written under the work directory before the state is
	// seeded. They are how an operator's own script (a recovery-test
	// validator under the workflows root) exists on disk before a command
	// names it. A path must stay inside the work directory.
	Files []File `yaml:"files"`

	// Doc is a one-line note about what this scenario is for. It exists so
	// scenarios read as documentation of the situations the CLI is
	// contractually expected to handle.
	Doc string `yaml:"doc"`
}

// File is one file a scenario places in the work directory.
type File struct {
	// Path is relative to the work directory, with no ".." and no leading
	// slash. The directories on the way are created 0755, which is what the
	// product's custody check asks of a path to a script.
	Path string `yaml:"path"`
	// Mode is an octal permission such as "0755".
	Mode string `yaml:"mode"`
	// Content has ${WORK}, ${STATE_DB}, ${REMOTE} and ${LOCAL} expanded.
	Content string `yaml:"content"`
}

type Retention struct {
	Timezone             string `yaml:"timezone"`
	WeekStartsOn         string `yaml:"week_starts_on"`
	DailyDays            int    `yaml:"daily_days"`
	WeeklyMonths         int    `yaml:"weekly_months"`
	MonthlyMonths        int    `yaml:"monthly_months"`
	ProtectLastKnownGood *bool  `yaml:"protect_last_known_good"`
}

type Source struct {
	ID         string      `yaml:"id"`
	BackupSets []BackupSet `yaml:"backup_sets"`
}

type BackupSet struct {
	ID         string      `yaml:"id"`
	Remote     Remote      `yaml:"remote"`
	Include    []string    `yaml:"include"`
	Completion Completion  `yaml:"completion"`
	StaleAfter string      `yaml:"stale_after"`
	Validation *Validation `yaml:"validation"`
	Artifacts  []Artifact  `yaml:"artifacts"`

	// RemotePath and LocalPath default to directories inside the work
	// directory. Setting either points the backup set somewhere else,
	// which is how the unreachable-remote cases are built without needing
	// a container: a local remote whose directory does not exist is
	// genuinely unreachable.
	RemotePath string `yaml:"remote_path"`
	LocalPath  string `yaml:"local_path"`
}

type Remote struct {
	Type string `yaml:"type"`
}

type Completion struct {
	Strategy  string `yaml:"strategy"`
	StableFor string `yaml:"stable_for"`
}

type Validation struct {
	Hash string `yaml:"hash"`
}

// Artifact is one file placed on the remote side before any command runs.
type Artifact struct {
	Name string `yaml:"name"`
	// Size in bytes. Contents are deterministic: a PRNG seeded from the
	// scenario, backup set, artifact name and Seed, so two runs on two
	// machines produce byte-identical trees and a digest assertion means
	// something.
	Size int    `yaml:"size"`
	Seed string `yaml:"seed"`
	// Format wraps those bytes so the file is a real one of its kind:
	// "gzip" writes them as a gzip stream (header time zero, so it is as
	// deterministic as the bytes). Empty leaves them raw, which is what a
	// dump or an opaque blob is. A case about a reader that decodes the file
	// (the built-in recovery check, retnd#1111) needs the first; one about a
	// checksum over opaque bytes needs the second.
	Format string `yaml:"format"`
	// MTime is a coarse offset from now: "now", "now-90d", "now-1h",
	// "now-45m". This is the single documented place wall-clock time
	// enters a fixture, and it is here only because `status` freshness
	// (FR-24) is defined against now by the product itself. Offsets are
	// chosen with hours of margin against their thresholds, so a run's own
	// duration can never flip a verdict.
	MTime string `yaml:"mtime"`
}

// Load reads one scenario by name from dir (fixtures/scenarios).
func Load(dir, name string) (Scenario, error) {
	var s Scenario
	path := filepath.Join(dir, name, "scenario.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		return s, fmt.Errorf("loading scenario %q: %w", name, err)
	}
	dec := yaml.NewDecoder(strings.NewReader(string(raw)))
	dec.KnownFields(true)
	if err := dec.Decode(&s); err != nil {
		return s, fmt.Errorf("parsing %s: %w", path, err)
	}
	s.Name = name
	if s.State == "" {
		s.State = "none"
	}
	if s.Replay == "" {
		s.Replay = "fetch"
	}
	if s.PollInterval == "" {
		s.PollInterval = "15m"
	}
	switch s.State {
	case "none", "absent", "replay", "corrupt":
	default:
		return s, fmt.Errorf("scenario %q: unsupported state %q (expected none, absent, replay or corrupt)", name, s.State)
	}
	return s, nil
}

// parseOffset turns "now", "now-90d" and friends into a time.
//
// Deliberately coarse: there is no way to express seconds-scale offsets,
// because a fixture that depends on a threshold it is seconds away from
// is a flake waiting for a slow machine.
func parseOffset(spec string, now time.Time) (time.Time, error) {
	if spec == "" || spec == "now" {
		return now, nil
	}
	if !strings.HasPrefix(spec, "now-") {
		return time.Time{}, fmt.Errorf("mtime %q: expected \"now\" or \"now-<N><unit>\" with unit m, h or d", spec)
	}
	body := spec[len("now-"):]
	if body == "" {
		return time.Time{}, fmt.Errorf("mtime %q: missing offset", spec)
	}
	unit := body[len(body)-1]
	n, err := strconv.Atoi(body[:len(body)-1])
	if err != nil || n < 0 {
		return time.Time{}, fmt.Errorf("mtime %q: %q is not a non-negative number", spec, body[:len(body)-1])
	}
	switch unit {
	case 'm':
		return now.Add(-time.Duration(n) * time.Minute), nil
	case 'h':
		return now.Add(-time.Duration(n) * time.Hour), nil
	case 'd':
		return now.Add(-time.Duration(n) * 24 * time.Hour), nil
	default:
		return time.Time{}, fmt.Errorf("mtime %q: unsupported unit %q (expected m, h or d)", spec, string(unit))
	}
}
