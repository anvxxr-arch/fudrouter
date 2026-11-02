package egress

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	xproxy "golang.org/x/net/proxy"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/netguard"
)

type poolEndpoint struct {
	scheme  string
	address string
	ip      net.IP
	port    string
}

// The environment pins the ONE trusted pool socket; the database can choose
// HTTP vs SOCKS5 on it, not turn the loopback exception into an arbitrary
// internal-network proxy. Requiring a literal IP also closes proxy DNS rebinding.
// Missing gate/endpoint/consumer makes pool inert without even parsing proxy_url.
func configuredPool(connectionURL string) (*poolEndpoint, string, bool, error) {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(PoolEnabledEnv))) {
	case "1", "true", "on", "yes":
	default:
		return nil, "", false, nil
	}
	raw := strings.TrimSpace(os.Getenv(PoolURLEnv))
	consumer := os.Getenv(PoolKeyEnv)
	if raw == "" || consumer == "" {
		return nil, "", false, nil
	}
	trusted, err := parsePoolEndpoint(raw)
	if err != nil {
		return nil, "", false, err
	}
	if connectionURL == "" {
		return trusted, consumer, true, nil
	}
	chosen, err := parsePoolEndpoint(connectionURL)
	if err != nil {
		return nil, "", false, err
	}
	if !chosen.ip.Equal(trusted.ip) || chosen.port != trusted.port {
		return nil, "", false, errors.New("egress pool: connection endpoint is not operator-approved")
	}
	return chosen, consumer, true, nil
}

func parsePoolEndpoint(raw string) (*poolEndpoint, error) {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
		(u.Path != "" && u.Path != "/") || (u.Scheme != "http" && u.Scheme != "socks5") {
		return nil, errors.New("egress pool: invalid endpoint (credentials belong in env)")
	}
	ip := net.ParseIP(u.Hostname())
	port, err := strconv.Atoi(u.Port())
	if ip == nil || ip.IsUnspecified() || ip.IsMulticast() || err != nil || port < 1 || port > 65535 {
		return nil, errors.New("egress pool: endpoint requires a literal IP and explicit port")
	}
	p := strconv.Itoa(port)
	return &poolEndpoint{scheme: u.Scheme, address: net.JoinHostPort(ip.String(), p), ip: ip, port: p}, nil
}

// A proxy's socket is not the upstream target, so a Control hook on that socket
// alone would erase the SSRF boundary. Resolve locally, apply the shared rule,
// and send only the verified NUMERIC destination to CONNECT/SOCKS5. The proxy
// never gets a hostname it can re-resolve, including after a redirect. HTTP Host
// and TLS SNI still come from the original request URL in http.Transport.
func pinnedTarget(ctx context.Context, network, address string) (string, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", errors.New("egress pool: invalid upstream address")
	}
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return "", errors.New("egress pool: only TCP upstreams are supported")
	}
	var ips []net.IPAddr
	if ip := net.ParseIP(host); ip != nil {
		ips = []net.IPAddr{{IP: ip}}
	} else {
		ips, err = net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return "", fmt.Errorf("egress pool: upstream DNS: %w", err)
		}
	}
	for _, ip := range ips {
		if ip.Zone != "" || (network == "tcp4" && ip.IP.To4() == nil) ||
			(network == "tcp6" && ip.IP.To4() != nil) {
			continue
		}
		if !netguard.AllowPrivate() && netguard.IsBlockedIP(ip.IP) {
			continue
		}
		return net.JoinHostPort(ip.IP.String(), port), nil
	}
	return "", errors.New("ssrf guard: no public upstream address for pool tunnel")
}

func (p *poolEndpoint) dial(ctx context.Context, network, address, username, consumer string) (net.Conn, error) {
	// The header/tunnel phase gets the same 20s budget as a source-bound dial.
	// It must not inherit a deadline-free streaming request and stall forever.
	wait, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	target, err := pinnedTarget(wait, network, address)
	if err != nil {
		return nil, err
	}
	if p.scheme == "socks5" {
		d, err := xproxy.SOCKS5("tcp", p.address,
			&xproxy.Auth{User: username, Password: consumer},
			&net.Dialer{Timeout: 20 * time.Second, KeepAlive: 30 * time.Second})
		if err != nil {
			return nil, errors.New("egress pool: invalid SOCKS5 configuration")
		}
		conn, err := d.(xproxy.ContextDialer).DialContext(wait, "tcp", target)
		if err != nil {
			return nil, fmt.Errorf("egress pool: SOCKS5 tunnel: %w", err)
		}
		return conn, nil
	}
	return p.connectHTTP(wait, target, username, consumer)
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(b []byte) (int, error) { return c.reader.Read(b) }

func (p *poolEndpoint) connectHTTP(ctx context.Context, target, username, consumer string) (net.Conn, error) {
	// This is the explicit trusted-pool exception, not ProxyFromEnvironment.
	// p.address was matched to the operator's literal endpoint before any dial.
	conn, err := (&net.Dialer{Timeout: 20 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, "tcp", p.address)
	if err != nil {
		return nil, fmt.Errorf("egress pool: connect: %w", err)
	}
	ok := false
	defer func() {
		if !ok {
			_ = conn.Close()
		}
	}()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	req := &http.Request{
		Method: http.MethodConnect, URL: &url.URL{Host: target}, Host: target,
		Header: make(http.Header),
	}
	req.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(username+":"+consumer)))
	if err := req.Write(conn); err != nil {
		return nil, fmt.Errorf("egress pool: CONNECT write: %w", err)
	}
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, req)
	if err != nil {
		return nil, fmt.Errorf("egress pool: CONNECT response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("egress pool: CONNECT refused (HTTP %d)", resp.StatusCode)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	// ReadResponse may have buffered tunnel bytes. Dropping the reader truncates
	// the first TLS record or an early stream frame; never close resp.Body on
	// CONNECT success, because it represents the live tunnel rather than JSON.
	ok = true
	return &bufferedConn{Conn: conn, reader: reader}, nil
}
