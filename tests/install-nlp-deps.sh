#!/bin/bash

set -e
set -x
set -o pipefail

srcdir=`dirname $0`/..
srcdir=`realpath $srcdir`

which genienlp >/dev/null 2>&1 || pip3 install --user 'git+https://github.com/stanford-oval/genienlp@10b51e4623a4e8cc0ec893a37507f26393244c31#egg=genienlp'
which genienlp

mkdir -p $srcdir/tests/embeddings
