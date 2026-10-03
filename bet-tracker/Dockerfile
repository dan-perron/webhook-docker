FROM node:24

WORKDIR /usr/src/app
ENV TZ=America/Chicago

COPY package.json yarn.lock ./
RUN yarn --frozen-lockfile

# Bundle app source
COPY . .
RUN yarn build && yarn test

# SQLite lives on a volume mounted here.
ENV DATABASE_PATH=/data/bet-tracker.sqlite
VOLUME /data

EXPOSE 3003

CMD ["node", "./built/server.js"]
