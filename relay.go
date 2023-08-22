package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
)

// Server ...
type Server struct {
	host string
	port string
}

// Client ...
type Client struct {
	conn net.Conn
}

// Config ...
type Config struct {
	Host string
	Port string
}

// New ...
func New(config *Config) *Server {
	return &Server{
		host: config.Host,
		port: config.Port,
	}
}

func checkIfSourceIsAllowed(ip string) bool {
	// Check if IPv6
	if strings.Contains(ip, ":") {
		// Allow IPv6 localhost
		if strings.HasPrefix(ip, "[::1]") {
			return true
		}

		// Check against allowed IPv6 CIDR ranges
		cfv6Ranges := []string{
			"2400:cb00::/32",
			"2606:4700::/32",
			"2803:f800::/32",
			"2405:b500::/32",
			"2405:8100::/32",
			"2a06:98c0::/29",
			"2c0f:f248::/32",
			// etc
		}

		for _, r := range cfv6Ranges {
			if strings.HasPrefix(ip, r) {
				return true
			}
		}

		return false
	}

	// Check IPv4
	if strings.HasPrefix(ip, "127.0.0.1") {
		return true
	}

	cfv4Ranges := []string{
		"173.245.48.0/20",
		"103.21.244.0/22",
		"103.22.200.0/22",
		"103.31.4.0/22",
		"141.101.64.0/18",
		"108.162.192.0/18",
		"190.93.240.0/20",
		"188.114.96.0/20",
		"197.234.240.0/22",
		"198.41.128.0/17",
		"162.158.0.0/15",
		"104.16.0.0/13",
		"104.24.0.0/14",
		"172.64.0.0/13",
		"131.0.72.0/22",
		// etc
	}

	for _, r := range cfv4Ranges {
		if strings.HasPrefix(ip, r) {
			return true
		}
	}

	return false
}

// Run ...
func (server *Server) Run() {
	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%s", server.host, server.port))
	if err != nil {
		log.Fatal(err)
	}
	defer listener.Close()

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Fatal(err)
		}

		ip := conn.RemoteAddr().String()
		if !checkIfSourceIsAllowed(ip) {
			_ = conn.Close()
			continue
		}

		client := &Client{
			conn: conn,
		}
		go client.handleRequest()
	}
}

func (client *Client) handleRequest() {
	reader := bufio.NewReader(client.conn)
	header, _ := reader.ReadBytes(byte(13))
	if len(header) < 1 {
		return
	}
	address := strings.Replace(string(header[:len(header)-1]), "$", ":", -1)
	if strings.Contains(address, "temp-mail.org") {
		return
	}
	fmt.Printf("Dialing to %s...\r\n", address)
	rConn, err := net.Dial("tcp", address)
	if err != nil {
		fmt.Println(fmt.Errorf("failed to connect to socket: %v", err))
		return
	}

	// transmit data
	go Copy(client.conn, rConn)
	Copy(rConn, client.conn)

	_ = rConn.Close()
}

func Copy(src io.Reader, dst io.Writer) {
	buf := make([]byte, 256*1024)

	_, err := io.CopyBuffer(dst, src, buf[:cap(buf)])
	if err != nil {
		fmt.Println(err)
	}
}

func main() {
	var ip string
	var port string
	flag.StringVar(&ip, "b", "0.0.0.0", "Server IP address")
	flag.StringVar(&port, "p", "6666", "Server Port number")
	flag.Parse()
	server := New(&Config{
		Host: ip,
		Port: port,
	})
	server.Run()
}
