#
# Copyright (c) 2013, Joyent, Inc. All rights reserved.
#

NAME=mockcn

#
# Directories
#
TOP := $(shell pwd)

#
# Files
#
#JS_FILES	:= $(shell ls *.js) $(shell find lib test -name '*.js')
#JSL_CONF_NODE	 = tools/jsl.node.conf
#JSL_FILES_NODE   = $(JS_FILES)
#JSSTYLE_FILES	 = $(JS_FILES)
PKG_DIR = $(BUILD)/pkg
MOCKCN_PKG_DIR = $(PKG_DIR)/root/opt/smartdc/mockcn
RELEASE_TARBALL=$(NAME)-pkg-$(STAMP).tar.bz2
CLEAN_FILES += ./node_modules build/pkg $(NAME)-pkg-*.tar.bz2
REPO_MODULES := src/node-pack
JSSTYLE_FLAGS = -o indent=4,doxygen,unparenthesized-return=0

ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_VERSION=v0.8.23
	NODE_PREBUILT_TAG=zone
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
# Repo-specific targets
#
.PHONY: all
all:

.PHONY: test
test:
	@echo "Success!"

#
# Packaging targets
#
.PHONY: pkg
pkg: all
	rm -rf $(PKG_DIR)
	mkdir -p $(MOCKCN_PKG_DIR)/ur-agent
	cp -PR smf \
		$(MOCKCN_PKG_DIR)
	cp ur-agent/ur-agent ur-agent/amqp-plus.js \
		$(MOCKCN_PKG_DIR)/ur-agent
	cp -PR ur-agent/node_modules \
		$(MOCKCN_PKG_DIR)/ur-agent
	cp -PR ur-modules/* \
		$(MOCKCN_PKG_DIR)/ur-agent/node_modules
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

