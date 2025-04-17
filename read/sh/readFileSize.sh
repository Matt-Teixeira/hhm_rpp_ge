#! /bin/bash

filepath="$1"

name="${filepath##*/}"

size=$(wc --bytes < $filepath)

echo $size

exit