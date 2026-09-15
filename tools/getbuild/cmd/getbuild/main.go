// Command getbuild resolves the pinned retnd build, runs the
// identity handshake against it, and prints where the binaries landed.
//
// It is the one-command answer to "which build would the suites test
// right now", which is a question worth being able to ask before a suite
// run rather than after it.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/backupdproject/backupd-tests/tools/getbuild"
)

func main() {
	root, err := getbuild.RepoRoot(".")
	if err != nil {
		fail(err)
	}
	pin, err := getbuild.LoadPin(root)
	if err != nil {
		fail(err)
	}
	build, err := getbuild.Resolve(root, pin)
	if err != nil {
		fail(err)
	}
	info, err := getbuild.Handshake(build)
	if err != nil {
		fail(err)
	}
	out, _ := json.MarshalIndent(struct {
		Mode       string `json:"mode"`
		Provenance string `json:"provenance"`
		CLI        string `json:"cli"`
		Web        string `json:"web,omitempty"`
		SourceDir  string `json:"source_dir,omitempty"`
		Version    string `json:"version"`
		Commit     string `json:"commit"`
		Rclone     string `json:"rclone"`
		Go         string `json:"go"`
	}{build.Mode, build.Provenance, build.CLI, build.Web, build.Checkout, info.BinaryVersion, info.Commit, info.Rclone, info.Go}, "", "  ")
	fmt.Println(string(out))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "getbuild:", err)
	os.Exit(1)
}
