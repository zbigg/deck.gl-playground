DEVIL_HOST ?= zbigg@s27.mydevil.net
FQDN       ?= deckgl-sandbox.dev.qwaka.eu
DIST       ?= dist
REMOTE_DIR := domains/$(FQDN)/public_html/

.PHONY: build deploy

build:
	yarn build

deploy: build
	rsync -r --delete --checksum $(DIST)/ $(DEVIL_HOST):$(REMOTE_DIR)
