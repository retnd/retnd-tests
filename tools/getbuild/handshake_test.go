package getbuild

import "testing"

// TestCommitsAgree pins the one comparison the identity handshake rests
// on. Both directions of abbreviation have to work (the pin carries a
// full sha, a -X main.commit build arg is sometimes short) and a value
// too short to identify anything has to read as disagreement rather than
// as a lucky prefix match.
func TestCommitsAgree(t *testing.T) {
	const full = "8ad310014b5be92e75789c8cff4167942d0c8e42"
	cases := []struct {
		name, observed, expected string
		want                     bool
	}{
		{"identical", full, full, true},
		{"observed abbreviates expected", "8ad3100", full, true},
		{"expected abbreviates observed", full, "8ad3100", true},
		{"dirty suffix tolerated", full + "-dirty", full, true},
		{"different commits", full, "c51a07f0e377b69d43260186c0c73764e1d65f6b", false},
		{"too short to identify anything", "8ad", full, false},
		{"empty observed", "", full, false},
		{"the none placeholder a dev build carries", "none", full, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := commitsAgree(tc.observed, tc.expected); got != tc.want {
				t.Errorf("commitsAgree(%q, %q) = %v, want %v", tc.observed, tc.expected, got, tc.want)
			}
		})
	}
}

// TestParseVersion runs the same four lines under both names the command
// has had. The pin is free to point either side of the 0.3.3 rename, and
// this parser runs before any case does, so a build that cannot be
// identified is a run that refuses rather than a run that certifies
// nothing. The second half of the table is the one that would have caught
// what happened here: the parser matched on the literal `backupd`,
// so against an `backupd` build it silently reported an empty version while
// the commit line still lined up and the handshake still passed.
func TestParseVersion(t *testing.T) {
	for _, name := range []string{"backupd", "backupd"} {
		t.Run(name, func(t *testing.T) {
			info := parseVersion(name + " 8ad3100\nrclone v1.71.1\ngo go1.27.0\ncommit 8ad310014b5be92e75789c8cff4167942d0c8e42\n")
			if info.BinaryVersion != "8ad3100" || info.Rclone != "v1.71.1" || info.Go != "go1.27.0" {
				t.Errorf("parseVersion misread the first three lines: %+v", info)
			}
			if info.Commit != "8ad310014b5be92e75789c8cff4167942d0c8e42" {
				t.Errorf("commit = %q", info.Commit)
			}
		})
	}
}

// TestParseVersionIgnoresAnUnrelatedFirstWord is the positive control for
// the case above: the parser accepting two names must not mean it accepts
// any name, or the "which build is this" line would read a number off
// whatever happened to be printed first.
func TestParseVersionIgnoresAnUnrelatedFirstWord(t *testing.T) {
	info := parseVersion("backupd 8ad3100\ncommit 8ad310014b5be92e75789c8cff4167942d0c8e42\n")
	if info.BinaryVersion != "" {
		t.Errorf("BinaryVersion = %q, want empty: only the CLI names itself on that line", info.BinaryVersion)
	}
}
