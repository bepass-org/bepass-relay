// Relay is a package that provides functionality for relaying network traffic.
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/peterbourgon/ff/v4"
	"github.com/peterbourgon/ff/v4/ffhelp"
)

const BUFFER_SIZE = 2048

func run(ctx context.Context, l *slog.Logger, bind string) error {
	listener, err := net.Listen("tcp", bind)
	if err != nil {
		return err
	}
	defer listener.Close()

	for {
		select {
		case <-ctx.Done():
			return nil
		default:
			conn, err := listener.Accept()
			if err != nil {
				l.Error("failed to accept connection", "error", err.Error())
				continue
			}

			src := netip.MustParseAddrPort(conn.RemoteAddr().String())

			// Check if srcIP is in the whitelist
			if !connFilter.isSourceAllowed(src.Addr()) {
				l.Debug("blocked connection", "address", src)
				conn.Close()
				continue
			}

			go handleConnection(l, conn)
		}
	}
}

func handleConnection(l *slog.Logger, lConn net.Conn) {
	reader := bufio.NewReader(lConn)

	header, _ := reader.ReadBytes(byte(13))
	if len(header) < 1 {
		lConn.Close()
		return
	}

	inputHeader := strings.Split(string(header[:len(header)-1]), "@")
	if len(inputHeader) < 2 {
		lConn.Close()
		return
	}

	network := "tcp"
	if inputHeader[0] == "udp" {
		network = "udp"
	}

	address := strings.Replace(inputHeader[1], "$", ":", -1)
	dh, _, err := net.SplitHostPort(address)
	if err != nil {
		lConn.Close()
		return
	}

	// check if ip is not blocked
	blockFlag := false
	addr, err := netip.ParseAddr(dh)
	if err != nil {
		// the host may not be an IP, try to resolve it
		ips, err := net.LookupIP(dh)
		if err != nil {
			lConn.Close()
			return
		}

		// parse the first IP and use it
		addr, _ = netip.AddrFromSlice(ips[0])
	}

	// If the address is invalid or not allowed as a destination, set the block flag.
	blockFlag = !addr.IsValid() || !connFilter.isDestinationAllowed(addr)

	if blockFlag {
		l.Debug("destination host is blocked", "address", address)
		lConn.Close()
		return
	}

	switch network {
	case "tcp":
		rConn, err := net.Dial(network, address)
		if err != nil {
			l.Error("failed to dial", "protocol", network, "address", address, "error", err.Error())
			lConn.Close()
			return
		}

		go handleTCP(lConn, rConn)

	case "udp":
		go handleUDPOverTCP(l, lConn, address)
	}
	l.Debug("relaying connection", "protocol", network, "address", address)
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
	fs := ff.NewFlagSet("bepass-relay")
	var (
		verbose = fs.Bool('v', "verbose", "enable verbose logging")
		bind    = fs.String('b', "bind", "0.0.0.0:6666", "bind address")
	)

	err := ff.Parse(fs, os.Args[1:])
	switch {
	case errors.Is(err, ff.ErrHelp):
		fmt.Fprintf(os.Stderr, "%s\n", ffhelp.Flags(fs))
		os.Exit(0)
	case err != nil:
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	l := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if *verbose {
		l = slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelDebug}))
	}

	ctx, _ := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	if err := run(ctx, l, *bind); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	<-ctx.Done()
}
