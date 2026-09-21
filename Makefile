.PHONY: all build test vet clean run docker

all: build

build:
	go build -o fudrouter ./cmd/fudrouter

test:
	go test ./...

vet:
	go vet ./...

clean:
	rm -f fudrouter

run: build
	./fudrouter

docker:
	docker compose up --build

.DEFAULT_GOAL := build
