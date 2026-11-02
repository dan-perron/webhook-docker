FROM node:24

WORKDIR /usr/src/app
ENV TZ=America/Chicago

COPY package.json yarn.lock ./
RUN yarn --frozen-lockfile

# Bundle app source. Tests run against an in-memory mongod
# (mongodb-memory-server downloads it on first use).
COPY . .
RUN yarn build && yarn test

EXPOSE 3005

CMD ["node", "./built/server.js"]
