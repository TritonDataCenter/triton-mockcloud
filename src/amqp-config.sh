#!/bin/bash

rabbitmq=$(mdata-get rabbitmq)

cat <<EOF
amqp_login=$(echo ${rabbitmq} | cut -d ':' -f 1)
amqp_password=$(echo ${rabbitmq} | cut -d ':' -f 2)
amqp_host=$(echo ${rabbitmq} | cut -d ':' -f 3)
amqp_port=$(echo ${rabbitmq} | cut -d ':' -f 4)
EOF

exit 0
