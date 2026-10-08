.PHONY: all scene-protocol compositor-proxy gateway viewer login clean

all: gateway viewer login

# --- libs ---

scene-protocol:
	cd libs/scene-protocol && yarn run tsc

# --- packages (TS) ---

compositor-proxy: scene-protocol
	cd packages/compositor-proxy && yarn run rimraf dist types && yarn build:native && yarn build:typescript

gateway: compositor-proxy
	cd packages/gateway && yarn run rimraf dist && yarn run tsc && node dist/build-dconf.js && node dist/build-audio.js

viewer: scene-protocol
	cd packages/viewer && yarn build:wasm && yarn tsc --noEmit && yarn vite build

# --- packages (Rust) ---

login:
	cargo build --release --locked --manifest-path packages/login/Cargo.toml

# --- housekeeping ---

clean:
	rm -rf libs/scene-protocol/dist libs/scene-protocol/types
	rm -rf packages/compositor-proxy/build packages/compositor-proxy/dist packages/compositor-proxy/types
	rm -rf packages/gateway/dist
	rm -rf packages/viewer/dist
	cd packages/login && cargo clean
