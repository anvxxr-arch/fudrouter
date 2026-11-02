package cfp

import "net"

// Keep the rejection seam out of the shipping API; a real native session also
// requires Cloudflare's TLS/WS service and is not a unit-test dependency.
func RejectSourceForTest(opt Options, actualIP net.IP, err error) {
	rejectSource(opt, actualIP, err)
}
