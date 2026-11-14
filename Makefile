.PHONY: build test dev
build:
	cd frontend && npm ci && npm run build
	rm -rf backend/static
	cp -R frontend/dist backend/static
	mkdir -p bin
	cd backend && go build -trimpath -o ../bin/earthtrend .
test:
	cd backend && go test -race ./...
dev:
	cd frontend && npm run dev
