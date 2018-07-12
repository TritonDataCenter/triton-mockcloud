#
# Copyright (c) 2018, Joyent, Inc.
#

NAME=mockcloud

JS_FILES := $(shell find lib -name '*.js')
ESLINT_FILES := $(JS_FILES)
CLEAN_FILES += ./node_modules
RELEASE_TARBALL=$(NAME)-pkg-$(STAMP).tar.bz2


#XXX
#REPO_ROOT	= $(shell pwd)
#JS_FILES	:= $(shell find src bin lib test -name '*.js')
#JSL_CONF_NODE	 = tools/jsl.node.conf
#JSL_FILES_NODE   = $(JS_FILES)
#JSSTYLE_FILES	 = $(JS_FILES)
#PKG_DIR = $(BUILD)/pkg
#MOCKCLOUD_PKG_DIR = $(PKG_DIR)/root/opt/smartdc/mockcloud

ifeq ($(shell uname -s),SunOS)
	# sdcnode: use a recent node version (v6 for now) and recent
	# triton-origin image (multiarch@18.1.0 is being explored now).
	NODE_PREBUILT_VERSION=v6.14.3
	NODE_PREBUILT_TAG=zone
        # minimal-multiarch 18.1.0
	NODE_PREBUILT_IMAGE = 1ad363ec-3b83-11e8-8521-2f68a4a34d5d
endif


#
# Included definitions
#
include ./tools/mk/Makefile.defs
include ./tools/mk/Makefile.node_modules.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	NPM_EXEC :=
	NPM = npm
endif
include ./tools/mk/Makefile.smf.defs

#
# Due to the unfortunate nature of npm, the Node Package Manager, there appears
# to be no way to assemble our dependencies without running the lifecycle
# scripts.  These lifecycle scripts should not be run except in the context of
# an agent installation or uninstallation, so we provide a magic environment
# varible to disable them here.
#
#XXX needed?
NPM_ENV =		SDC_AGENT_SKIP_LIFECYCLE=yes \
			MAKE_OVERRIDES='CTFCONVERT=/bin/true CTFMERGE=/bin/true'
#RUN_NPM_INSTALL =	$(NPM_ENV) $(NPM) install


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
release: $(RELEASE_TARBALL)

$(RELEASE_TARBALL):
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
	(cd $(PKG_DIR); $(TAR) -jcf $(TOP)/$(RELEASE_TARBALL) root)

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
include ./tools/mk/Makefile.node_modules.targ
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
endif
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ
