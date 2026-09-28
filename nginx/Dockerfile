FROM nginx:1.25-alpine

RUN apk add --no-cache --virtual .build-deps \
    git \
    gcc \
    libc-dev \
    make \
    openssl-dev \
    pcre-dev \
    zlib-dev \
    linux-headers \
    curl

WORKDIR /tmp

RUN git clone --depth 1 --branch v1.1.0 https://github.com/google/ngx_brotli.git

WORKDIR /tmp/ngx_brotli
RUN git submodule update --init --depth 1

WORKDIR /tmp
RUN NGINX_VERSION=$(nginx -v 2>&1 | grep -oP '\d+\.\d+\.\d+') && \
    curl -sSL "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" -o nginx.tar.gz && \
    tar -xzf nginx.tar.gz && \
    cd nginx-${NGINX_VERSION} && \
    ./configure \
      --with-compat \
      --add-dynamic-module=/tmp/ngx_brotli && \
    make -j$(nproc) modules && \
    cp objs/ngx_http_brotli_filter_module.so /usr/lib/nginx/modules/ && \
    cp objs/ngx_http_brotli_static_module.so /usr/lib/nginx/modules/
