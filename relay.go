// Relay is a package that provides functionality for relaying network traffic.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"strings"
)

const BUFFER_SIZE = 256 * 1024

type Server struct {
	host string
	port string
}

type Client struct {
	conn net.Conn
}

type Config struct {
	Host string
	Port string
}

func New(config *Config) *Server {
	return &Server{
		host: config.Host,
		port: config.Port,
	}
}

func (server *Server) Run() {
	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%s", server.host, server.port))
	if err != nil {
		log.Fatal(err)
	}
	defer func() {
		_ = listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Fatal(err)
		}

		src, err := netip.ParseAddrPort(conn.RemoteAddr().String())
		if err != nil {
			log.Printf("unable to parse host %v", conn.RemoteAddr())
			_ = conn.Close()
			continue
		}

		// Check if srcIP is in the whitelist
		if !connFilter.isSourceAllowed(src.Addr()) {
			log.Printf("blocked connection from: %v", src)
			conn.Close()
			continue
		}

		go (&Client{conn: conn}).handleRequest()
	}
}

func (client *Client) handleRequest() {
	defer func() {
		_ = client.conn.Close()
	}()
	reader := bufio.NewReader(client.conn)
	header, _ := reader.ReadBytes(byte(13))
	if len(header) < 1 {
		return
	}
	inputHeader := strings.Split(string(header[:len(header)-1]), "@")
	if len(inputHeader) < 2 {
		return
	}
	network := "tcp"
	if inputHeader[0] == "udp" {
		network = "udp"
	}
	address := strings.Replace(inputHeader[1], "$", ":", -1)
	if strings.Contains(address, "temp-mail.org") {
		return
	}

	dh, _, err := net.SplitHostPort(address)
	if err != nil {
		return
	}
	// check if ip is not blocked
	blockFlag := false
	addr, err := netip.ParseAddr(dh)
	if err != nil {
		// the host may not be an IP, try to resolve it
		ips, err := net.LookupIP(dh)
		if err != nil {
			return
		}

		// parse the first IP and use it
		addr, _ = netip.AddrFromSlice(ips[0])
	}

	// If the address is invalid or not allowed as a destination, set the block flag.
	blockFlag = !addr.IsValid() || !connFilter.isDestinationAllowed(addr)

	if blockFlag {
		log.Printf("destination host is blocked: %s\n", address)
		return
	}

	if network == "udp" {
		handleUDPOverTCP(client.conn, address)
		return
	}

	// transmit data
	log.Printf("%s Dialing to %s...\n", network, address)

	rConn, err := net.Dial(network, address)

	if err != nil {
		log.Println(fmt.Errorf("failed to connect to socket: %v", err))
		return
	}

	// transmit data
	go Copy(client.conn, rConn)
	Copy(rConn, client.conn)

	_ = rConn.Close()
}

// Copy reads from src and writes to dst until either EOF is reached on src or
// an error occurs. It returns the number of bytes copied and any error
// encountered. Copy uses a fixed-size buffer to efficiently copy data between
// the source and destination.
func Copy(src io.Reader, dst io.Writer) {
	buf := make([]byte, BUFFER_SIZE)

	_, err := io.CopyBuffer(dst, src, buf[:cap(buf)])
	if err != nil {
		fmt.Println(err)
	}
}

func main() {
	var config Config
	flag.StringVar(&config.Host, "b", "0.0.0.0", "Server IP address")
	flag.StringVar(&config.Port, "p", "6666", "Server Port number")
	flag.Parse()
	server := New(&config)
	server.Run()
}
