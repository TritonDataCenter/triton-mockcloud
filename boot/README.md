Mockcloud VMs prefer to use brand=joyent-minimal. Unfortunately with
brand=joyent-minimal VMs, there is no way to build an image where custom
code is run on initial boot other than using a user-script.

Because we need *some* user-script to setup a mockcloud VM, we'll work with the
standard Triton core user-script
(https://github.com/joyent/sdcadm/blob/master/etc/setup/user-script) which does
the following.

- runs /opt/smartdc/boot/setup.sh on initial boot
- runs /opt/smartdc/boot/configure.sh on every boot

Mockcloud's scripts for these will just be stubs that ensure the
"mockcloud-setup" transient service is imported. Actual mockcloud
setup details are in that service (see "smf/method/mockcloud-setup").

Typically the Triton user-script will guard to ensure setup.sh is
only called once on first boot. However, mockcloud's setup.sh will
be re-entrant so that a minimal user-script can be:

    /opt/smartdc/boot/setup.sh
