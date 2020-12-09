require("dotenv-safe").config();
import cors from "cors";
import express from "express";
import Router from "express-promise-router";
import helmet from "helmet";
import createError from "http-errors";
import passport from "passport";
import { Strategy as GitHubStrategy } from "passport-github";
import { join } from "path";
import "reflect-metadata";
import fetch from "node-fetch";
import { assert } from "superstruct";
import { createConnection, getConnection } from "typeorm";
import { createTokens } from "./auth/createTokens";
import { isAuth } from "./auth/isAuth";
import { __prod__ } from "./constants";
import { Match } from "./entities/Match";
import { Message } from "./entities/Message";
import { User } from "./entities/User";
import { View } from "./entities/View";
import { getAge, getUserIdOrder } from "./utils";
import {
  GetMessageStruct,
  MessageStruct,
  OneUserStruct,
  ReportStruct,
  UnmatchStruct,
  UpdatePushTokenStruct,
  UpdateUser,
  UserCodeImgs,
  ViewStruct,
} from "./validation";
import http from "http";
import WebSocket, { Server } from "ws";
import url from "url";
import { verify } from "jsonwebtoken";
import { getUser } from "./queries/getUser";
import { Report } from "./entities/Report";
import { createMessageAdapter } from "@slack/interactive-messages";
import {
  queuePushNotifToSend,
  startPushNotificationRunner,
} from "./pushNotifications";
import Redis from "ioredis";
import {
  RateLimiterRedis,
  IRateLimiterStoreOptions,
} from "rate-limiter-flexible";
import { rateLimitMiddleware } from "./rateLimitMiddleware";

const SECONDS_IN_A_DAY = 86400;

const main = async () => {
  const conn = await createConnection({
    type: "postgres",
    database: __prod__ ? undefined : "vsinder",
    url: __prod__ ? process.env.DATABASE_URL : undefined,
    entities: [join(__dirname, "./entities/*")],
    migrations: [join(__dirname, "./migrations/*")],
    // synchronize: !__prod__,
    logging: !__prod__,
  });
  console.log("connected, running migrations now");
  await conn.runMigrations();
  console.log("migrations ran");

  const redisClient = new Redis(process.env.REDIS_URL, {
    enableOfflineQueue: false,
  });

  const defaultRateLimitOpts: IRateLimiterStoreOptions = {
    storeClient: redisClient,
    execEvenly: false,
    blockDuration: SECONDS_IN_A_DAY,
  };

  startPushNotificationRunner();

  const wsUsers: Record<
    string,
    { ws: WebSocket; openChatUserId: string | null }
  > = {};
  const wsSend = (key: string, v: any) => {
    if (key in wsUsers) {
      wsUsers[key].ws.send(JSON.stringify(v));
    }
  };

  passport.use(
    new GitHubStrategy(
      {
        clientID: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL: `${process.env.SERVER_URL}/auth/github/callback`,
      },
      async (githubAccessToken, _, profile, cb) => {
        try {
          let user = await User.findOne({ githubId: profile.id });
          const data: Partial<User> = {
            githubAccessToken,
            githubId: profile.id,
            photoUrl:
              profile.photos?.[0].value ||
              (profile._json as any).avatar_url ||
              "",
            other: profile._json,
            profileUrl: profile.profileUrl,
            username: profile.username,
          };
          if (user) {
            await User.update(user.id, data);
          } else {
            data.bio = (profile._json as any)?.bio || "";
            data.displayName = profile.displayName;
            user = await User.create(data).save();
          }
          cb(undefined, createTokens(user));
        } catch (err) {
          console.log(err);
          cb(new Error("internal error"));
        }
      }
    )
  );
  passport.serializeUser((user: any, done) => {
    done(null, user.accessToken);
  });

  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin: "*",
      maxAge: __prod__ ? 86400 : undefined,
      exposedHeaders: [
        "access-token",
        "refresh-token",
        "content-type",
        "content-length",
      ],
    })
  );
  const slackInteractions = createMessageAdapter(
    process.env.SLACK_SIGNING_SECRET
  );
  app.post("/slack", slackInteractions.expressMiddleware());
  app.use(express.json());
  app.use(passport.initialize());
  const router = Router();
  app.use(router);

  if (!__prod__) {
    app.get("/all-users", async (_, res) => res.send(await User.find()));
    app.post("/login", async (req, res) =>
      res.send(createTokens((await User.findOne(req.body.userId))!))
    );
  }

  slackInteractions.action({ type: "button" }, async (payload, respond) => {
    if (!payload.actions || !payload.actions.length) {
      respond({ text: "no actions?" });
      return;
    }

    const [{ action_id, value }] = payload.actions;
    if (action_id === "shadow-ban") {
      try {
        await User.update(value, { shadowBanned: true });
        respond({ text: "banned" });
      } catch (err) {
        respond({ text: "Something went wrong: " + err.message });
      }
    }
  });

  router.post("/email/login", async (req, res, next) => {
    const { email, password } = req.body;
    if (
      email !== process.env.APPLE_EMAIL &&
      password !== process.env.APPLE_PASSWORD
    ) {
      next(
        createError(
          400,
          "this is for the apple tester only, you should login with github"
        )
      );
      return;
    }

    let user = await User.findOne({ appleId: process.env.APPLE_EMAIL });
    if (!user) {
      user = await User.create({
        appleId: process.env.APPLE_EMAIL,
        photoUrl: "https://via.placeholder.com/150x150",
        shadowBanned: true,
      }).save();
    }

    res.send(createTokens(user));
  });

  router.post("/apple/login", async (req, res, next) => {
    const { user: appleId } = req.body;
    if (typeof appleId !== "string") {
      next(createError(400, "something went wrong with apple auth"));
      return;
    }

    let user = await User.findOne({ appleId });
    if (!user) {
      user = await User.create({
        displayName: req.body?.fullName?.givenName || "",
        goal: "friendship",
        birthday: new Date(),
        codeImgIds: ["v56pytkbl-1606765556556.png"],
        appleId,
        photoUrl: "https://via.placeholder.com/150x150",
        shadowBanned: true,
      }).save();
    } else if (!user.goal) {
      user.displayName = req.body?.fullName?.givenName || "";
      user.goal = "friendship";
      user.birthday = new Date();
      user.codeImgIds = ["v56pytkbl-1606765556556.png"];
      await user.save();
    }

    res.send(createTokens(user));
  });

  router.get("/auth/github/rn", (req, res, next) => {
    const state = Buffer.from(JSON.stringify({ rn: true })).toString("base64");
    passport.authenticate("github", {
      session: false,
      state,
    })(req, res, next);
  });

  router.get("/auth/github", (req, res, next) => {
    const state = Buffer.from(JSON.stringify({ rn: false })).toString("base64");
    passport.authenticate("github", {
      session: false,
      state,
    })(req, res, next);
  });

  router.get(
    "/auth/github/callback",
    passport.authenticate("github"),
    (req: any, res) => {
      if (!req.user.accessToken || !req.user.refreshToken) {
        res.send(`something went wrong`);
        return;
      }
      const { state } = req.query;
      const { rn } = JSON.parse(Buffer.from(state, "base64").toString());
      if (rn) {
        res.redirect(
          `${__prod__ ? `vsinder://` : `exp://127.0.0.1:19000/`}tokens/${
            req.user.accessToken
          }/${req.user.refreshToken}`
        );
      } else {
        res.redirect(
          `http://localhost:54321/callback/${req.user.accessToken}/${req.user.refreshToken}`
        );
      }
    }
  );

  router.put(
    "/user/imgs",
    isAuth(),
    rateLimitMiddleware(
      new RateLimiterRedis({
        ...defaultRateLimitOpts,
        points: 100,
        duration: SECONDS_IN_A_DAY,
        keyPrefix: "rl/user/imgs/",
      })
    ),
    async (req: any, res, next) => {
      try {
        assert(req.body, UserCodeImgs);
      } catch (err) {
        next(createError(400, err.message));
        return;
      }

      await User.update(req.userId, req.body);

      res.json({ ok: true });
    }
  );

  router.put(
    "/user/push-token",
    isAuth(),
    rateLimitMiddleware(
      new RateLimiterRedis({
        ...defaultRateLimitOpts,
        points: 20,
        duration: SECONDS_IN_A_DAY,
        keyPrefix: "rl/user/push-token/",
      })
    ),
    async (req: any, res, next) => {
      try {
        assert(req.body, UpdatePushTokenStruct);
      } catch (err) {
        next(createError(400, err.message));
        return;
      }

      await User.update(req.userId, req.body);

      res.json({ ok: true });
    }
  );

  router.put(
    "/user",
    isAuth(),
    rateLimitMiddleware(
      new RateLimiterRedis({
        ...defaultRateLimitOpts,
        points: 100,
        duration: SECONDS_IN_A_DAY,
        keyPrefix: "rl/user/",
      })
    ),
    async (req: any, res, next) => {
      if (req.body.goal === "friendship") {
        req.body.ageRangeMin = 18;
        req.body.ageRangeMax = 33;
        req.body.location = "online";
      }
      if (!req.body.location) {
        req.body.location = "online";
      }
      try {
        assert(req.body, UpdateUser);
      } catch (err) {
        next(createError(400, err.message));
        return;
      }

      await User.update(req.userId, req.body);

      res.json({ user: await getUser(req.userId) });
    }
  );

  router.get(
    "/feed",
    isAuth(),
    rateLimitMiddleware(
      new RateLimiterRedis({
        ...defaultRateLimitOpts,
        points: 500,
        duration: SECONDS_IN_A_DAY,
        keyPrefix: "rl/feed/",
      }),
      "You've been using the app too much and hit the rate limit, come back tomorrow"
    ),
    async (req: any, res, next) => {
      const user = await User.findOne(req.userId);
      if (!user) {
        next(createError(400, "your account got deleted"));
        return;
      }

      if (!user.birthday) {
        next(
          createError(
            400,
            "you need to set your birthday in the profile settings"
          )
        );
        return;
      }

      const myAge = getAge(new Date(user.birthday));
      const paramNum = user.global ? 6 : 4;
      const loveWhere = `
        and goal = 'love'
        and "genderToShow" = $${paramNum}
        and $${paramNum + 1} <= date_part('year', age(birthday))
        and $${paramNum + 2} >= date_part('year', age(birthday))
        and "ageRangeMin" <= $${paramNum + 3}
        and "ageRangeMax" >= $${paramNum + 4}
        and (location = $${paramNum + 5} ${
        user.global ? `or global = true` : ""
      })
        ${
          user.genderToShow !== "everyone"
            ? `and gender = $${paramNum + 6}`
            : ""
        }
    `;
      const loveParams = [
        req.userId,
        req.userId,
        req.userId,
        ...(user.global ? [user.location, user.location] : []),
        user.gender, // my gender matches their gender they want to see
        user.ageRangeMin,
        user.ageRangeMax,
        myAge,
        myAge,
        user.location,
      ];
      if (user.genderToShow !== "everyone") {
        loveParams.push(
          user.genderToShow // their gender matches my gender I want to see
        );
      }
      const friendWhere = `and date_part('year', age(birthday)) ${
        myAge >= 18 ? ">=" : "<"
      } 18`;
      const friendParams = [req.userId, req.userId, req.userId];

      const profiles = await getConnection().query(
        `
        select id, flair, "displayName", date_part('year', age(birthday)) "age", bio, "codeImgIds", "photoUrl"
        from "user" u
        left join view v on v."viewerId" = $1 and u.id = v."targetId"
        left join view v2 on $2 = v2."targetId" and v2.liked = true and u.id = v2."viewerId"
        where
        v is null
        and u.id != $3
        ${user.goal === "love" ? loveWhere : friendWhere}
        and array_length("codeImgIds", 1) >= 1
        and "shadowBanned" != true
        order by
          case
                ${
                  user.goal === "love" && user.global
                    ? `
                when (u.location = $4 and v2 is not null)
                then random() - 1.2
                when (u.location = $5)
                then random() - 1
                `
                    : ""
                }
                when (v2 is not null)
                then random() - .2
                else random()
              end
            limit 20;
        `,
        user.goal === "love" ? loveParams : friendParams
      );

      res.json({
        profiles,
      });
    }
  );

  router.get(
    "/matches/:cursor",
    isAuth(),
    rateLimitMiddleware(
      new RateLimiterRedis({
        ...defaultRateLimitOpts,
        points: 500,
        duration: SECONDS_IN_A_DAY,
        keyPrefix: "rl/matches/",
      }),
      "You've been using the app too much and hit the rate limit, come back tomorrow"
    ),
    async (req: any, res) => {
      res.send({
        matches: await getConnection().query(
          `
        select
        case
          when u.id = ma."userId1" then ma.read2
          else ma.read1
        end "read",
        ma.id "matchId",
        u.id "userId", u.flair, u."photoUrl", u."displayName", date_part('epoch', ma."createdAt") * 1000 "createdAt",
        (select json_build_object('text', text, 'createdAt', date_part('epoch', m."createdAt")*1000)
        from message m
        where (m."recipientId" = ma."userId1" and m."senderId" = ma."userId2")
        or
        (m."senderId" = ma."userId1" and m."recipientId" = ma."userId2")
        order by m."createdAt" desc limit 1) message
        from match ma
        inner join "user" u on u.id != $1 and (u.id = ma."userId1" or u.id = ma."userId2")
        where (ma."userId1" = $2 or ma."userId2" = $3) and ma.unmatched = false
        limit 150
      `,
          [req.userId, req.userId, req.userId]
        ),
      });
    }
  );

  router.get(
    "/messages/:userId/:cursor?",
    isAuth(),
    async (req: any, res, next) => {
      try {
        req.params.cursor = req.params.cursor
          ? parseInt(req.params.cursor)
          : undefined;
        assert(req.params, GetMessageStruct);
      } catch (err) {
        next(createError(400, err.message));
        return;
      }
      const { userId, cursor } = req.params;
      const qb = getConnection()
        .createQueryBuilder()
        .select("m")
        .from(Message, "m")
        .where(
          `((m."recipientId" = :u1 and m."senderId" = :u2) or (m."recipientId" = :u3 and m."senderId" = :u4))`,
          {
            u1: userId,
            u2: req.userId,
            u3: req.userId,
            u4: userId,
          }
        )
        .orderBy(`"createdAt"`, "DESC")
        .take(21);
      if (cursor && Number.isInteger(cursor)) {
        qb.andWhere(`m."createdAt" < :cursor`, { cursor: new Date(cursor) });
      }
      const messages = await qb.getMany();
      res.send({
        messages: messages.slice(0, 20),
        hasMore: messages.length === 21,
      });

      if (req.userId in wsUsers) {
        wsUsers[req.userId].openChatUserId = userId;
      }

      if (!cursor) {
        const userIdOrder = getUserIdOrder(userId, req.userId);
        getConnection()
          .createQueryBuilder()
          .update(Match)
          .set({
            [userIdOrder.userId1 === req.userId ? "read1" : "read2"]: true,
          })
          .where(`"userId1" = :userId1 and "userId2" = :userId2`, userIdOrder)
          .execute();
      }
    }
  );

  router.post(
    "/unmatch",
    isAuth(),
    rateLimitMiddleware(
      new RateLimiterRedis({
        ...defaultRateLimitOpts,
        points: 100,
        duration: SECONDS_IN_A_DAY,
        keyPrefix: "rl/unmatch/",
      })
    ),
    async (req: any, res, next) => {
      try {
        assert(req.body, UnmatchStruct);
      } catch (err) {
        next(createError(400, err.message));
        return;
      }

      const { userId } = req.body;

      await Match.delete(getUserIdOrder(req.userId, userId));
      wsSend(userId, { type: "unmatch", userId: req.userId });

      res.send({ ok: true });
    }
  );

  router.post(
    "/report",
    isAuth(),
    rateLimitMiddleware(
      new RateLimiterRedis({
        ...defaultRateLimitOpts,
        points: 100,
        duration: SECONDS_IN_A_DAY,
        keyPrefix: "rl/report/",
      })
    ),
    async (req: any, res, next) => {
      try {
        assert(req.body, ReportStruct);
      } catch (err) {
        next(createError(400, err.message));
        return;
      }

      const { userId, message, unmatchOrReject } = req.body;

      if (unmatchOrReject === "unmatch") {
        await Match.delete(getUserIdOrder(req.userId, userId));
        wsSend(userId, { type: "unmatch", userId: req.userId });
      }

      if (unmatchOrReject === "reject") {
        await View.insert({
          viewerId: req.userId,
          targetId: userId,
          liked: false,
        });
      }

      res.send({ ok: true });

      // sketchy not catching errors ;;
      Report.insert({ reporterId: req.userId, targetId: userId, message });
      User.findOne(userId).then((u) => {
        fetch(process.env.SLACK_REPORT_URL, {
          method: "post",
          headers: {
            "Content-type": "application/json",
          },
          body: JSON.stringify({
            blocks: [
              {
                type: "section",
                fields: [
                  {
                    type: "mrkdwn",
                    text: "*Reporter id:*\n" + req.userId,
                  },
                  {
                    type: "mrkdwn",
                    text: "*Target id:*\n" + userId,
                  },
                  {
                    type: "mrkdwn",
                    text: "*type:*\n" + unmatchOrReject,
                  },
                  {
                    type: "mrkdwn",
                    text: "*message:*\n" + message,
                  },
                ],
              },
              ...(u?.codeImgIds.map((id) => ({
                type: "image",
                title: {
                  type: "plain_text",
                  text: id,
                  emoji: true,
                },
                image_url: `https://img.vsinder.com/${id}`,
                alt_text: "code",
              })) || []),
              ...(u?.photoUrl
                ? [
                    {
                      type: "image",
                      title: {
                        type: "plain_text",
                        text: u.displayName + " | " + u.photoUrl,
                        emoji: true,
                      },
                      image_url: u.photoUrl,
                      alt_text: "code",
                    },
                  ]
                : []),
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    action_id: "shadow-ban",
                    text: {
                      type: "plain_text",
                      emoji: true,
                      text: "shadow ban",
                    },
                    style: "primary",
                    value: userId,
                  },
                ],
              },
            ],
          }),
        });
      });
    }
  );

  router.post(
    "/message",
    isAuth(),
    rateLimitMiddleware(
      new RateLimiterRedis({
        ...defaultRateLimitOpts,
        points: 1000,
        duration: SECONDS_IN_A_DAY,
        keyPrefix: "rl/message/",
      })
    ),
    async (req: any, res, next) => {
      try {
        assert(req.body, MessageStruct);
      } catch (err) {
        next(createError(400, err.message));
        return;
      }

      const m = await Message.create({
        ...req.body,
        senderId: req.userId,
      } as Message).save();

      wsSend(m.recipientId, { type: "new-message", message: m });

      res.send({ message: m });

      if (
        !(m.recipientId in wsUsers) ||
        wsUsers[m.recipientId].openChatUserId !== req.userId
      ) {
        const userIdOrder = getUserIdOrder(req.userId, m.recipientId);
        Match.update(
          { ...userIdOrder, unmatched: false },
          { [userIdOrder.userId1 === m.recipientId ? "read1" : "read2"]: false }
        );
      }

      if (!(m.recipientId in wsUsers)) {
        queuePushNotifToSend({
          idToSendTo: m.recipientId,
          otherId: req.userId,
          type: "message",
          text: m.text.slice(0, 100),
        });
      }
    }
  );

  router.post(
    "/view",
    isAuth(),
    rateLimitMiddleware(
      new RateLimiterRedis({
        ...defaultRateLimitOpts,
        points: 100,
        duration: SECONDS_IN_A_DAY,
        blockDuration: 0,
        keyPrefix: "rl/view/",
      }),
      `You've hit the rate limit of 100 swipes a day, come back in 24 hours`
    ),
    async (req: any, res, next) => {
      try {
        assert(req.body, ViewStruct);
      } catch (err) {
        next(createError(400, err.message));
        return;
      }
      const { userId, liked } = req.body;
      let fav: View | undefined = undefined;
      try {
        const [_fav] = await Promise.all([
          liked
            ? View.findOne({
                viewerId: userId,
                targetId: req.userId,
                liked: true,
              })
            : Promise.resolve(undefined),
          View.insert({
            viewerId: req.userId,
            targetId: userId,
            liked,
          }),
        ]);
        fav = _fav;
      } catch (err) {
        if (err.message.includes("duplicate key")) {
          res.json({
            match: false,
            ok: false,
          });
          return;
        } else {
          throw err;
        }
      }

      let match = false;
      if (fav) {
        await Match.insert(getUserIdOrder(userId, req.userId));
        match = true;
      }

      res.json({
        match,
        ok: true,
      });

      if (match) {
        const ids = getUserIdOrder(userId, req.userId);
        wsSend(userId, {
          type: "new-match",
          ...ids,
        });
        wsSend(req.userId, {
          type: "new-match",
          ...ids,
        });
        // does not have a ws connection
        if (!(userId in wsUsers)) {
          queuePushNotifToSend({
            idToSendTo: userId,
            otherId: req.userId,
            type: "match",
          });
        }
      }

      if (liked) {
        User.update(userId, { numLikes: () => '"numLikes" + 1' });
        wsSend(userId, { type: "new-like" });
      }
    }
  );

  router.get(
    "/user/:id",
    isAuth(),
    rateLimitMiddleware(
      new RateLimiterRedis({
        ...defaultRateLimitOpts,
        points: 200,
        duration: SECONDS_IN_A_DAY,
        keyPrefix: "rl/user/:id",
      })
    ),
    async (req: any, res, next) => {
      try {
        assert(req.params, OneUserStruct);
      } catch (err) {
        next(createError(400, err.message));
        return;
      }
      const { id } = req.params;

      const { userId1, userId2 } = getUserIdOrder(req.userId, id);
      const isMe = userId1 === userId2;

      const [user] = await getConnection().query(
        `
    select id, flair, "displayName", date_part('year', age(birthday)) "age", bio, "codeImgIds", "photoUrl"
    ${
      isMe
        ? `
    from "user" u
    where  id = $1
    `
        : `
    from "user" u, match m
    where  m."userId1" = $1 and m."userId2" = $2 and id = $3
    `
    }
    `,
        isMe ? [id] : [userId1, userId2, id]
      );

      res.json({
        user,
      });
    }
  );

  router.get("/me", isAuth(false), async (req: any, res) => {
    if (!req.userId) {
      res.json({
        user: null,
      });
      return;
    }

    res.json({
      user: await getUser(req.userId),
    });
  });

  router.use((err: any, _: any, res: any, next: any) => {
    if (res.headersSent) {
      return next(err);
    }
    if (err.statusCode) {
      res.status(err.statusCode).send(err.message);
    } else {
      console.log(err);
      res.status(500).send("internal server error");
    }
  });

  const server = http.createServer(app);
  const wss = new Server({ noServer: true });
  wss.on("connection", (ws: WebSocket, userId: string) => {
    if (!userId) {
      ws.terminate();
      return;
    }

    // console.log("ws open: ", userId);
    wsUsers[userId] = { openChatUserId: null, ws };

    ws.on("message", (e: any) => {
      const {
        type,
        userId: openChatUserId,
      }: { type: "message-open"; userId: string } = JSON.parse(e);
      if (type === "message-open") {
        if (userId in wsUsers) {
          wsUsers[userId].openChatUserId = openChatUserId;
        }
      }
    });

    ws.on("close", () => {
      // console.log("ws close: ", userId);
      delete wsUsers[userId];
    });
  });
  server.on("upgrade", async function upgrade(request, socket, head) {
    const good = (userId: string) => {
      wss.handleUpgrade(request, socket, head, function done(ws) {
        wss.emit("connection", ws, userId);
      });
    };
    const bad = () => {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    };
    try {
      const {
        query: { accessToken, refreshToken },
      } = url.parse(request.url, true);
      if (
        !accessToken ||
        !refreshToken ||
        typeof accessToken !== "string" ||
        typeof refreshToken !== "string"
      ) {
        return bad();
      }
      try {
        const data = verify(
          accessToken,
          process.env.ACCESS_TOKEN_SECRET
        ) as any;
        return good(data.userId);
      } catch {}

      try {
        const data = verify(
          refreshToken,
          process.env.REFRESH_TOKEN_SECRET
        ) as any;
        const user = await User.findOne(data.userId);
        // token has been invalidated or user deleted
        if (!user || user.tokenVersion !== data.tokenVersion) {
          return bad();
        }
        return good(data.userId);
      } catch {}
    } catch {}

    return bad();
  });
  server.listen(process.env.PORT ? parseInt(process.env.PORT) : 3001, () => {
    console.log("server started");
  });
};

main();