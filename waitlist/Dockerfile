FROM node:22-alpine
WORKDIR /app
RUN addgroup -S waitlist && adduser -S waitlist -G waitlist && mkdir /app/data && chown -R waitlist:waitlist /app
COPY --chown=waitlist:waitlist server.mjs package.json ./
COPY --chown=waitlist:waitlist public ./public
USER waitlist
ENV HOST=0.0.0.0 PORT=3187 WAITLIST_DB=/app/data/waitlist.sqlite
EXPOSE 3187
CMD ["node", "server.mjs"]
