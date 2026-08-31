package harness

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	fixtures "github.com/spdrman/rclone-manager-tests/fixtures/lib"
	"github.com/spdrman/rclone-manager-tests/tools/getbuild"
	"github.com/spdrman/rclone-manager-tests/tools/statesnap"
)

// Runner executes cases against one build under test.
type Runner struct {
	// CLI is the absolute path to the backup-manager binary, already
	// through the identity handshake.
	CLI string
	// ScenarioDir is fixtures/scenarios.
	ScenarioDir string
	// DefaultTimeout bounds any case that does not set its own.
	DefaultTimeout time.Duration
	// Now anchors relative artifact mtimes for every scenario this runner
	// materialises, so a case and its fixture agree about what "90 days
	// ago" meant.
	Now time.Time
}

// Result is everything one case produced, in all four dimensions.
type Result struct {
	Case     Case
	Manifest fixtures.Manifest
	Norm     *Normalizer

	Argv     []string
	Exit     int
	Stdout   string
	Stderr   string
	Duration time.Duration

	Before statesnap.Snapshot
	After  statesnap.Snapshot
	Diff   statesnap.Diff

	// Setup records the pre-run invocations, so a case that fails because
	// its own setup failed says which one.
	Setup []Invocation
}

// Invocation is one process run.
type Invocation struct {
	Argv   []string
	Exit   int
	Stdout string
	Stderr string
}

// Run materialises the case's scenario into work, applies its setup and
// mutations, snapshots, runs the argv under test, and snapshots again.
func (r *Runner) Run(work string, c Case) (Result, error) {
	res := Result{Case: c}

	scenarioName := c.Scenario
	if scenarioName == "" {
		scenarioName = "no-fixture"
	}
	scn, err := fixtures.Load(r.ScenarioDir, scenarioName)
	if err != nil {
		return res, err
	}
	manifest, err := fixtures.Materialize(scn, fixtures.Options{Work: work, CLI: r.CLI, Now: r.Now})
	if err != nil {
		return res, err
	}
	res.Manifest = manifest
	res.Norm = NewNormalizer(manifest)

	for _, argv := range c.Setup {
		inv, err := r.invoke(res.Norm, expandAll(res.Norm, argv), c, false)
		if err != nil {
			return res, err
		}
		res.Setup = append(res.Setup, inv)
		if inv.Exit != 0 && !c.AllowSetupFailure {
			return res, fmt.Errorf("setup %v exited %d, so the case never reached the state it describes.\nstderr:\n%s",
				argv, inv.Exit, inv.Stderr)
		}
	}

	for _, m := range c.Mutate {
		if err := applyMutation(res.Norm, m); err != nil {
			return res, err
		}
	}

	for _, argv := range c.SetupAfterMutate {
		inv, err := r.invoke(res.Norm, expandAll(res.Norm, argv), c, false)
		if err != nil {
			return res, err
		}
		res.Setup = append(res.Setup, inv)
		if inv.Exit != 0 && !c.AllowSetupFailure {
			return res, fmt.Errorf("recovery step %v exited %d, so the case never reached the state it describes.\nstderr:\n%s",
				argv, inv.Exit, inv.Stderr)
		}
	}

	res.Before, err = statesnap.Take(manifest.Work, manifest.StateDB)
	if err != nil {
		return res, fmt.Errorf("snapshotting before the run: %w", err)
	}

	res.Argv = expandAll(res.Norm, c.Argv)
	started := time.Now()
	inv, err := r.invoke(res.Norm, res.Argv, c, true)
	res.Duration = time.Since(started)
	if err != nil {
		return res, err
	}
	res.Exit, res.Stdout, res.Stderr = inv.Exit, inv.Stdout, inv.Stderr

	res.After, err = statesnap.Take(manifest.Work, manifest.StateDB)
	if err != nil {
		return res, fmt.Errorf("snapshotting after the run: %w", err)
	}
	res.Diff = statesnap.Compare(res.Before, res.After)
	return res, nil
}

func (r *Runner) invoke(n *Normalizer, argv []string, c Case, underTest bool) (Invocation, error) {
	timeout := r.DefaultTimeout
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	if underTest && c.TimeoutSeconds > 0 {
		timeout = time.Duration(c.TimeoutSeconds) * time.Second
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, r.CLI, argv...)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	// TZ is pinned so any date the product renders is rendered the same
	// way on a developer's laptop and on a build host. LC_ALL is pinned
	// for the same reason.
	cmd.Env = append(os.Environ(), "TZ=UTC", "LC_ALL=C")
	for k, v := range c.Env {
		cmd.Env = append(cmd.Env, k+"="+n.Expand(v))
	}

	if underTest && c.Signal != "" {
		return r.invokeWithSignal(cmd, &stdout, &stderr, c)
	}

	err := cmd.Run()
	inv := Invocation{Argv: argv, Stdout: stdout.String(), Stderr: stderr.String()}
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		inv.Exit = 0
	case errors.As(err, &exitErr):
		inv.Exit = exitErr.ExitCode()
	default:
		return inv, fmt.Errorf("running %v: %w", argv, err)
	}
	if ctx.Err() != nil {
		return inv, fmt.Errorf("running %v: timed out after %s", argv, timeout)
	}
	return inv, nil
}

// invokeWithSignal gives `daemon` a bounded run: start it, let it do the
// work the case is about, then ask it to stop the way a service manager
// would. Killing it instead would make every shutdown-path assertion
// untestable, which is exactly the part of FR-1 most worth pinning.
func (r *Runner) invokeWithSignal(cmd *exec.Cmd, stdout, stderr *bytes.Buffer, c Case) (Invocation, error) {
	inv := Invocation{Argv: cmd.Args[1:]}
	stop, err := time.ParseDuration(c.StopAfter)
	if err != nil {
		return inv, fmt.Errorf("stop_after %q: %w", c.StopAfter, err)
	}
	sig := syscall.SIGTERM
	if strings.EqualFold(c.Signal, "INT") {
		sig = syscall.SIGINT
	}
	if err := cmd.Start(); err != nil {
		return inv, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case err := <-done:
		inv.Stdout, inv.Stderr = stdout.String(), stderr.String()
		inv.Exit = exitCode(err)
		return inv, fmt.Errorf("the process exited on its own after %s, before the case could signal it: exit %d\nstderr:\n%s",
			c.StopAfter, inv.Exit, inv.Stderr)
	case <-time.After(stop):
	}

	if err := cmd.Process.Signal(sig); err != nil {
		return inv, fmt.Errorf("sending %v: %w", sig, err)
	}
	select {
	case err := <-done:
		inv.Stdout, inv.Stderr = stdout.String(), stderr.String()
		inv.Exit = exitCode(err)
		return inv, nil
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		inv.Stdout, inv.Stderr = stdout.String(), stderr.String()
		return inv, fmt.Errorf("the process ignored %v for 30s and had to be killed", sig)
	}
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

func expandAll(n *Normalizer, argv []string) []string {
	out := make([]string, len(argv))
	for i, a := range argv {
		out[i] = n.Expand(a)
	}
	return out
}

// applyMutation performs one operator-plausible act of damage on the
// fixture, or lets time pass. Every verb here is something a real
// operator or a real incident can do to a deployment: delete the state
// database, truncate a sidecar, scribble over an artifact, or simply
// wait long enough for a freshness threshold to be crossed.
func applyMutation(n *Normalizer, spec string) error {
	fields := strings.Fields(spec)
	if len(fields) != 2 {
		return fmt.Errorf("mutate %q: expected \"<verb> <argument>\"", spec)
	}
	if fields[0] == "sleep" {
		// The one place a case is allowed to wait. It is only ever used
		// to cross a threshold in the direction that cannot un-cross
		// itself: a backup set that has been idle long enough to be stale
		// does not become fresh again while the test is running, so a
		// slow machine can only make the assertion more true.
		d, err := time.ParseDuration(fields[1])
		if err != nil {
			return fmt.Errorf("mutate %q: %w", spec, err)
		}
		time.Sleep(d)
		return nil
	}
	verb, path := fields[0], n.Expand(fields[1])
	if !filepath.IsAbs(path) {
		return fmt.Errorf("mutate %q: path must be absolute (use a ${WORK} token)", spec)
	}
	switch verb {
	case "rm":
		return os.Remove(path)
	case "truncate":
		return os.Truncate(path, 0)
	case "corrupt":
		f, err := os.OpenFile(path, os.O_WRONLY, 0)
		if err != nil {
			return err
		}
		defer func() { _ = f.Close() }()
		_, err = f.WriteAt([]byte("corrupted-by-the-test-fixture"), 0)
		return err
	default:
		return fmt.Errorf("mutate %q: unsupported verb %q (expected rm, truncate or corrupt)", spec, verb)
	}
}

// FromPin builds a Runner for the checked-in build under test, having
// first made that build prove its own identity.
//
// Both the suite and the harness's own self-tests go through here, so
// there is one place that decides which binary a run is about, and no way
// for a self-test to end up validating a different build from the suite
// it is supposed to be vouching for.
func FromPin(scenarioDir string) (*Runner, error) {
	root, err := getbuild.RepoRoot(scenarioDir)
	if err != nil {
		return nil, err
	}
	pin, err := getbuild.LoadPin(root)
	if err != nil {
		return nil, err
	}
	build, err := getbuild.Resolve(root, pin)
	if err != nil {
		return nil, err
	}
	if _, err := getbuild.Handshake(build); err != nil {
		return nil, err
	}
	return &Runner{
		CLI:            build.CLI,
		ScenarioDir:    filepath.Join(root, "fixtures", "scenarios"),
		DefaultTimeout: 120 * time.Second,
		Now:            time.Now(),
	}, nil
}
