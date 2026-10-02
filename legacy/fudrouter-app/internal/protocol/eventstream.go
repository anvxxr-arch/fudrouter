package protocol

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
)

// AWS EventStream frame codec (subset used by Kiro/CodeWhisperer).

var crcTable = crc32.MakeTable(crc32.Castagnoli)

func crc32c(b []byte) uint32 {
	return crc32.Checksum(b, crcTable)
}

// Frame is one EventStream message.
type Frame struct {
	Headers map[string]string
	Payload []byte
}

// EncodeFrame builds a binary EventStream frame.
func EncodeFrame(headers map[string]string, payload []byte) []byte {
	if headers == nil {
		headers = map[string]string{}
	}
	var hdr []byte
	for k, v := range headers {
		kb := []byte(k)
		vb := []byte(v)
		hdr = append(hdr, byte(len(kb)))
		hdr = append(hdr, kb...)
		hdr = append(hdr, 7) // string type
		var lenbuf [2]byte
		binary.BigEndian.PutUint16(lenbuf[:], uint16(len(vb)))
		hdr = append(hdr, lenbuf[:]...)
		hdr = append(hdr, vb...)
	}
	headersLen := len(hdr)
	totalLen := 12 + headersLen + len(payload) + 4 // prelude(12) + headers + payload + msg crc
	out := make([]byte, totalLen)
	binary.BigEndian.PutUint32(out[0:4], uint32(totalLen))
	binary.BigEndian.PutUint32(out[4:8], uint32(headersLen))
	binary.BigEndian.PutUint32(out[8:12], crc32c(out[0:8]))
	copy(out[12:], hdr)
	copy(out[12+headersLen:], payload)
	binary.BigEndian.PutUint32(out[totalLen-4:], crc32c(out[:totalLen-4]))
	return out
}

// DecodeFrames parses as many complete frames as available from buf.
// Returns frames, remaining bytes, error.
func DecodeFrames(buf []byte) ([]Frame, []byte, error) {
	var frames []Frame
	for {
		if len(buf) < 12 {
			return frames, buf, nil
		}
		totalLen := int(binary.BigEndian.Uint32(buf[0:4]))
		headersLen := int(binary.BigEndian.Uint32(buf[4:8]))
		if totalLen < 16 || totalLen > 0x1800000 {
			return frames, buf, fmt.Errorf("invalid eventstream total length %d", totalLen)
		}
		if crc32c(buf[0:8]) != binary.BigEndian.Uint32(buf[8:12]) {
			return frames, buf, fmt.Errorf("eventstream prelude crc mismatch")
		}
		if len(buf) < totalLen {
			return frames, buf, nil
		}
		frameBytes := buf[:totalLen]
		if crc32c(frameBytes[:totalLen-4]) != binary.BigEndian.Uint32(frameBytes[totalLen-4:]) {
			return frames, buf, fmt.Errorf("eventstream message crc mismatch")
		}
		hdrEnd := 12 + headersLen
		if hdrEnd > totalLen-4 {
			return frames, buf, fmt.Errorf("eventstream headers overflow")
		}
		headers, err := decodeHeaders(frameBytes[12:hdrEnd])
		if err != nil {
			return frames, buf, err
		}
		payload := frameBytes[hdrEnd : totalLen-4]
		frames = append(frames, Frame{Headers: headers, Payload: append([]byte(nil), payload...)})
		buf = buf[totalLen:]
	}
}

func decodeHeaders(b []byte) (map[string]string, error) {
	out := map[string]string{}
	i := 0
	for i < len(b) {
		if i >= len(b) {
			break
		}
		n := int(b[i])
		i++
		if i+n > len(b) {
			return nil, fmt.Errorf("header name overflow")
		}
		name := string(b[i : i+n])
		i += n
		if i >= len(b) {
			return nil, fmt.Errorf("header type missing")
		}
		typ := b[i]
		i++
		switch typ {
		case 0, 1: // bool false/true
			if typ == 1 {
				out[name] = "true"
			} else {
				out[name] = "false"
			}
		case 2, 3, 4, 5: // byte/short/int/long — skip
			sizes := map[byte]int{2: 1, 3: 2, 4: 4, 5: 8}
			i += sizes[typ]
		case 6: // bytes
			if i+2 > len(b) {
				return nil, fmt.Errorf("bytes header len")
			}
			l := int(binary.BigEndian.Uint16(b[i : i+2]))
			i += 2 + l
		case 7: // string
			if i+2 > len(b) {
				return nil, fmt.Errorf("string header len")
			}
			l := int(binary.BigEndian.Uint16(b[i : i+2]))
			i += 2
			if i+l > len(b) {
				return nil, fmt.Errorf("string header overflow")
			}
			out[name] = string(b[i : i+l])
			i += l
		case 8: // timestamp 8 bytes
			i += 8
		case 9: // uuid 16 bytes
			i += 16
		default:
			return nil, fmt.Errorf("unknown header type %d for %s", typ, name)
		}
	}
	return out, nil
}

// EncodeJSONEvent encodes event-type header + JSON payload frame.
func EncodeJSONEvent(eventType string, v any) ([]byte, error) {
	payload, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return EncodeFrame(map[string]string{
		":message-type": "event",
		":event-type":   eventType,
		":content-type": "application/json",
	}, payload), nil
}

// WriteJSONEvent writes one event frame to w.
func WriteJSONEvent(w io.Writer, eventType string, v any) error {
	b, err := EncodeJSONEvent(eventType, v)
	if err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}
