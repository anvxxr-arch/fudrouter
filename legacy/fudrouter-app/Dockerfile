FROM golang:1.23-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o fudrouter ./cmd/fudrouter

FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=builder /app/fudrouter /usr/local/bin/fudrouter

# Create non-root user
RUN addgroup -g 1000 fudrouter && \
    adduser -u 1000 -G fudrouter -s /bin/sh -D fudrouter

# Data directory
RUN mkdir -p /data && chown fudrouter:fudrouter /data

USER fudrouter

ENV DATA_DIR=/data
ENV FUDROUTER_API_ADDR=0.0.0.0:8011
ENV FUDROUTER_WEB_ADDR=0.0.0.0:8012
ENV FUDROUTER_MITM_ADDR=:8443

EXPOSE 8011 8012 8443

VOLUME ["/data"]

ENTRYPOINT ["fudrouter"]
