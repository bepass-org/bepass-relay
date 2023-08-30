package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
)

var cfRanges = []string{
	"127.0.0.0/8",
	"103.21.244.0/22",
	"103.22.200.0/22",
	"103.31.4.0/22",
	"104.16.0.0/12",
	"108.162.192.0/18",
	"131.0.72.0/22",
	"141.101.64.0/18",
	"162.158.0.0/15",
	"172.64.0.0/13",
	"173.245.48.0/20",
	"188.114.96.0/20",
	"190.93.240.0/20",
	"197.234.240.0/22",
	"198.41.128.0/17",
	"::1/128",
	"2400:cb00::/32",
	"2405:8100::/32",
	"2405:b500::/32",
	"2606:4700::/32",
	"2803:f800::/32",
	"2c0f:f248::/32",
	"2a06:98c0::/29",
}

var ipRange []*net.IPNet

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

func checkIfSourceIsAllowed(ipAddress string) bool {
	for _, r := range ipRange {
		ip := net.ParseIP(ipAddress)

		if r.Contains(ip) {
			return true
		}
	}

	return false
}

func init() {
	ipRange = []*net.IPNet{}

	for _, r := range cfRanges {
		_, cidr, err := net.ParseCIDR(r)
		if err != nil {
			continue
		}
		ipRange = append(ipRange, cidr)
	}
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
		sh, sp, err := net.SplitHostPort(ip)
		if err != nil {
			fmt.Println(fmt.Errorf("unable to parse host %s", ip))
			_ = conn.Close()
			continue
		}
		if !checkIfSourceIsAllowed(sh) {
			fmt.Println(fmt.Errorf("request from unacceptable source blocked: %s:%s", sh, sp))
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
	header, err := reader.ReadBytes(byte(13))
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

	if network == "udp" {
		handleUDPOverTCP(client.conn, address)
		return
	}

	// transmit data
	log.Printf("%s Dialing to %s...\r\n", network, address)
	rConn, err := net.Dial(network, address)
	if err != nil {
		log.Println(fmt.Errorf("failed to connect to socket: %v", err))
		return
	}

	go Copy(network, client.conn, rConn)
	Copy(network, rConn, client.conn)

	_ = rConn.Close()
	_ = client.conn.Close()
}

func Copy(network string, src io.Reader, dst io.Writer) {
	buf := make([]byte, 32*1024)

	for {
		nr, er := src.Read(buf)
		if nr > 0 {
			nw, ew := dst.Write(buf[0:nr])
			if nw < 0 || nr < nw {
				nw = 0
				if ew == nil {
					log.Println("error")
					return
				}
			}
			if ew != nil {
				log.Println(ew)
				return
			}
			if nr != nw {
				log.Println("error")
				return
			}
		}
		if er != nil {
			if er != errors.New("EOF") {
				log.Println(er)
			}
			return
		}
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
