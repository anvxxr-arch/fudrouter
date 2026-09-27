package proxy

// Test-only hooks. This file is compiled into the package's test binary and
// never into the production build, so anything exported here is invisible to
// main.go.
//
// It exists because the tests for the generic path's upstream bound need to
// shorten genericTimeout from two minutes to something they can wait for, and
// the test file itself has to live in proxy_test (not package proxy) to reuse
// the shared seeder in the tests package — which imports proxy, so an internal
// test in package proxy cannot import it back without an import cycle. This
// export is the standard way out of that: the unexported knob is opened here,
// and the external test drives it through SetGenericTimeoutForTest.

import "time"

// SetGenericTimeoutForTest overrides the generic path's body-read bound and
// returns a function that restores the previous value. Production never calls
// this; it exists so a test can verify the bound actually fires in under a
// second instead of two minutes.
func SetGenericTimeoutForTest(d time.Duration) (restore func()) {
	prev := genericTimeout
	genericTimeout = d
	return func() { genericTimeout = prev }
}

// GenericTimeoutForTest reports the bound currently in force, so a test can
// assert it matches what it set.
func GenericTimeoutForTest() time.Duration { return genericTimeout }
