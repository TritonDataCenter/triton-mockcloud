#
# Copyright (c) 2017, Joyent, Inc. All rights reserved.
#

NAME=mockcloud

#
# Directories
#
TOP := $(shell pwd)

#
# Files
#
REPO_ROOT	= $(shell pwd)
JS_FILES	:= $(shell ls *.js) $(shell find src bin lib test -name '*.js')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE   = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
PKG_DIR = $(BUILD)/pkg
MOCKCLOUD_PKG_DIR = $(PKG_DIR)/root/opt/smartdc/mockcloud
RELEASE_TARBALL=$(NAME)-pkg-$(STAMP).tar.bz2
CLEAN_FILES += ./node_modules build/pkg $(NAME)-pkg-*.tar.bz2
REPO_MODULES := src/node-pack
JSSTYLE_FLAGS = -o indent=4,doxygen,unparenthesized-return=0

ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_VERSION=v0.12.14
	NODE_PREBUILT_TAG=zone
	# Allow building on a SmartOS image other than sdc-smartos/1.6.3.
	NODE_PREBUILT_IMAGE = 18b094b0-eb01-11e5-80c1-175dac7ddf02
endif


#
# Included definitions
#
include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	NPM_EXEC :=
	NPM = npm
endif
include ./tools/mk/Makefile.node_deps.defs
include ./tools/mk/Makefile.smf.defs

#
# Due to the unfortunate nature of npm, the Node Package Manager, there appears
# to be no way to assemble our dependencies without running the lifecycle
# scripts.  These lifecycle scripts should not be run except in the context of
# an agent installation or uninstallation, so we provide a magic environment
# varible to disable them here.
#
NPM_ENV =		SDC_AGENT_SKIP_LIFECYCLE=yes \
			MAKE_OVERRIDES='CTFCONVERT=/bin/true CTFMERGE=/bin/true'
RUN_NPM_INSTALL =	$(NPM_ENV) $(NPM) install

TAPE	:= ./node_modules/.bin/tape

#
# Repo-specific targets
#
.PHONY: all
all:

.PHONY: test
test:
	@echo "Success!"

.PHONY: test-coal
test-coal:
#	./tools/rsync-to coal
	ssh root@10.99.99.7 'LOG_LEVEL=$(LOG_LEVEL) /zones/$$(vmadm lookup -1 alias=mockcloud0)/root/opt/smartdc/mockcloud/test/runtests $(TEST_ARGS)'

#
# Packaging targets
#
.PHONY: pkg
pkg: $(NODE_EXEC) all
	rm -rf $(PKG_DIR)
	mkdir -p $(MOCKCLOUD_PKG_DIR)
	mkdir -p $(MOCKCLOUD_PKG_DIR)/node_modules
	cp package.json $(MOCKCLOUD_PKG_DIR)/
	(cd $(MOCKCLOUD_PKG_DIR) && $(NPM_ENV) npm install)
	mkdir -p $(MOCKCLOUD_PKG_DIR)/bin
	mkdir -p $(MOCKCLOUD_PKG_DIR)/lib
	mkdir -p $(MOCKCLOUD_PKG_DIR)/mocks
	cp -PR smf \
		$(MOCKCLOUD_PKG_DIR)
	cp mocks/* $(MOCKCLOUD_PKG_DIR)/mocks/
	cp bin/* $(MOCKCLOUD_PKG_DIR)/bin/
	cp -r $(REPO_ROOT)/build/node $(MOCKCLOUD_PKG_DIR)/node
	cp -r lib/* $(MOCKCLOUD_PKG_DIR)/lib/
	cp -PR node_modules/* $(MOCKCLOUD_PKG_DIR)/node_modules/
	# Clean up some dev / build bits
	find $(PKG_DIR) -name "*.pyc" | xargs rm -f
	find $(PKG_DIR) -name "*.o" | xargs rm -f
	find $(PKG_DIR) -name c4che | xargs rm -rf   # waf build file
	find $(PKG_DIR) -name .wafpickle* | xargs rm -rf   # waf build file
	find $(PKG_DIR) -name .lock-wscript | xargs rm -rf   # waf build file
	find $(PKG_DIR) -name config.log | xargs rm -rf   # waf build file

release: $(RELEASE_TARBALL)

$(RELEASE_TARBALL): pkg
	(cd $(PKG_DIR); tar -jcf $(TOP)/$(RELEASE_TARBALL) root)

publish:
	@if [[ -z "$(BITS_DIR)" ]]; then \
      echo "error: 'BITS_DIR' must be set for 'publish' target"; \
      exit 1; \
    fi
	mkdir -p $(BITS_DIR)/$(NAME)
	cp $(RELEASE_TARBALL) $(BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)


#
# Includes
#
include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
endif
include ./tools/mk/Makefile.node_deps.targ
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ

