DEVIL_HOST ?= zbigg@s27.mydevil.net
FQDN       ?= deckgl-sandbox.dev.qwaka.eu
DIST       ?= dist
REMOTE_DIR := domains/$(FQDN)/public_html/

GH_PAGES_BRANCH ?= gh-pages
GH_PAGES_REMOTE ?= origin
GH_PAGES_BASE   ?= ./

export DIST GH_PAGES_BRANCH GH_PAGES_REMOTE

.PHONY: build deploy build-gh-pages deploy-gh-pages enable-gh-pages

build:
	yarn build

deploy: build
	rsync -r --delete --checksum $(DIST)/ $(DEVIL_HOST):$(REMOTE_DIR)

build-gh-pages:
	VITE_BASE=$(GH_PAGES_BASE) yarn build

deploy-gh-pages: build-gh-pages
	./scripts/deploy-gh-pages.sh

# One-time: point the repo's Pages site at the gh-pages branch.
enable-gh-pages:
	./scripts/enable-gh-pages.sh
