// Relay is a package that provides functionality for relaying network traffic.
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

		ip := conn.RemoteAddr().String()
		sh, sp, err := net.SplitHostPort(ip)
		if err != nil {
			log.Printf("unable to parse host %s\n", ip)
			_ = conn.Close()
			continue
		}
		if !checkIfSourceIsAllowed(sh) {
			log.Printf("request from unacceptable source blocked: %s:%s\n", sh, sp)
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
	addr := net.ParseIP(dh)
	if addr != nil {
		if checkIfDestinationIsBlocked(dh) {
			blockFlag = true
		}
	} else {
		ips, _ := net.LookupIP(dh)
		for _, ip := range ips {
			if ipv4 := ip.To4(); ipv4 != nil {
				if checkIfDestinationIsBlocked(ipv4.String()) {
					blockFlag = true
				}
			}
		}
	}

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
	buf := make([]byte, 256*1024)

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
