#
# Copyright (c) 2019, Joyent, Inc.
#

NAME=mockcloud

JS_FILES := $(shell find lib -name '*.js')
ESLINT_FILES := $(JS_FILES)
CLEAN_FILES += ./node_modules npm-debug.log

# We are including Triton agents as deps. Some of them include npm postinstall
# scripts for use when installing those agents via `apm install` on a TritonDC
# CN itself. We do *not* want to run these scripts for the `npm install` here.
NPM_ENV = SDC_AGENT_SKIP_LIFECYCLE=yes MAKE_OVERRIDES='CTFCONVERT=/bin/true CTFMERGE=/bin/true'
# TODO:
# - want to run `npm install *--production*` or whatever in CI build
# - if available, want to run `npm ci ...` in CI build. how to tell?

ifeq ($(shell uname -s),SunOS)
	# sdcnode: use a recent node version (v6 for now) and recent
	# triton-origin image (multiarch@18.1.0 is being explored now).
	NODE_PREBUILT_VERSION=v6.17.0
	NODE_PREBUILT_TAG=zone
	# minimal-multiarch 18.1.0
	NODE_PREBUILT_IMAGE = 1ad363ec-3b83-11e8-8521-2f68a4a34d5d
endif


#
# Included definitions
#

# triton-mockcloud is not a public module, so override
ENGBLD_DEST_OUT_PATH ?= /stor/builds

ENGBLD_USE_BUILDIMAGE	= true
ENGBLD_REQUIRE		:= $(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

include ./deps/eng/tools/mk/Makefile.node_modules.defs
ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
	include ./deps/eng/tools/mk/Makefile.agent_prebuilt.defs
else
	NODE_EXEC := $(shell which node)
	NODE = node
	NPM_EXEC := $(shell which npm)
	NPM = npm
endif
include ./deps/eng/tools/mk/Makefile.smf.defs

RELEASE_TARBALL = $(NAME)-pkg-$(STAMP).tar.gz
RELSTAGEDIR := /tmp/$(NAME)-$(STAMP)

BASE_IMAGE_UUID = b6ea7cb4-6b90-48c0-99e7-1d34c2895248
BUILDIMAGE_NAME = $(NAME)
BUILDIMAGE_DESC	= Triton Mockcloud

#
# Repo-specific targets
#
.PHONY: all
all: $(STAMP_NODE_MODULES)

.PHONY: git-hooks
git-hooks:
	ln -sf ../../tools/pre-commit.sh .git/hooks/pre-commit

.PHONY: fmt
fmt:: | $(ESLINT)
	$(ESLINT) --fix $(ESLINT_FILES)

.PHONY: release
release: all
	@echo "Building $(RELEASE_TARBALL)"
	# Stubs for Triton core user-script boot.
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(TOP)/deps/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R \
		$(TOP)/boot/* \
		$(RELSTAGEDIR)/root/opt/smartdc/boot/
	# Mockcloud code to /opt/triton/mockcloud.
	mkdir -p $(RELSTAGEDIR)/root/opt/triton/$(NAME)
	cp -PR \
		$(TOP)/README.md \
		$(TOP)/bin \
		$(TOP)/lib \
		$(TOP)/node_modules \
		$(TOP)/package.json \
		$(TOP)/smf \
		$(TOP)/tools \
		$(RELSTAGEDIR)/root/opt/triton/$(NAME)
	# sdcnode
	mkdir -p $(RELSTAGEDIR)/root/opt/triton/$(NAME)/build
	cp -PR \
		$(TOP)/build/node \
		$(RELSTAGEDIR)/root/opt/triton/$(NAME)/build
	# Trim sdcnode for size.
	rm -rf \
		$(RELSTAGEDIR)/root/opt/triton/$(NAME)/build/node/bin/npm \
		$(RELSTAGEDIR)/root/opt/triton/$(NAME)/build/node/lib/node_modules \
		$(RELSTAGEDIR)/root/opt/triton/$(NAME)/build/node/include \
		$(RELSTAGEDIR)/root/opt/triton/$(NAME)/build/node/share
	# Tar it up.
	(cd $(RELSTAGEDIR) && $(TAR) -I pigz -cf $(TOP)/$(RELEASE_TARBALL) root)
	@rm -rf $(RELSTAGEDIR)

publish: release
	mkdir -p $(ENGBLD_BITS_DIR)/$(NAME)
	cp $(RELEASE_TARBALL) $(ENGBLD_BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)


#
# Includes
#
include ./deps/eng/tools/mk/Makefile.deps
include ./deps/eng/tools/mk/Makefile.node_modules.targ
ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
	include ./deps/eng/tools/mk/Makefile.agent_prebuilt.targ
endif
include ./deps/eng/tools/mk/Makefile.smf.targ
include ./deps/eng/tools/mk/Makefile.targ
