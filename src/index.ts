import zlib from "zlib";
import etag from "etag";
import sha1 from "sha1";
import semver from "semver";
import fetch from "node-fetch";
import type { HttpFunction } from "@google-cloud/functions-framework/build/src/functions";
import { ParsedUrlQueryInput } from "querystring";

import cache from "./cache";
import { getBundleName } from "./utils/helper";
import findVersion from "./utils/findVersion";
import { createBundle } from "./bundler";

import { registry, additionalBundleResHeaders } from "./config";
import { PackageJSON, PackageVersions } from "./types";

export const stringify = (query: ParsedUrlQueryInput): string => {
  const str = Object.keys(query)
    .sort()
    .map((key) => `${key}=${query[key]}`)
    .join("&");
  return str ? `?${str}` : "";
};

export const app: HttpFunction = async (req, res): Promise<unknown> => {
  res.set("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") {
    // Send response to OPTIONS requests
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "3600");
    return res.status(204).send("");
  }

  if (req.method !== "GET") return "Invalid METHOD";
  /* eslint-disable */
  const match = /^\/(?:@([^\/]+)\/)?([^@\/]+)(?:@(.+?))?(?:\/(.+?))?(?:\?(.+))?$/.exec(
    req.url
  );

  if (!match) {
    return res.status(400).end("Invalid module ID");
  }

  const user = match[1];
  const id = match[2];
  const tag = match[3] || "latest";
  const deep = match[4];
  const queryString = match[5];

  const qualified = user ? `@${user}/${id}` : id;
  const query: ParsedUrlQueryInput = (queryString || "")
    .split("&")
    .reduce((query: ParsedUrlQueryInput, pair) => {
      if (!pair) return query;

      const [key, value] = pair.split("=");
      query[key] = value || true;
      return query;
    }, {});

  try {
    const result = await fetch(
      `${registry}/${encodeURIComponent(qualified).replace("%40", "@")}`
    );
    const packageRequested = await result.json();
    const { versions } = packageRequested;

    // checking if npm is returning the versions
    if (!versions) {
      return res.status(400).end("Invalid Module");
    }

    // checking if the version requested is valid and if it is present in the list
    const version = findVersion(packageRequested, tag);
    if (!semver.valid(version)) {
      return res.status(400).end("Invalid tag");
    }

    // If the user requests with a tagname
    // They should be redirected using the latest version number
    // react/latest ---> react/16.8
    if (version !== tag) {
      let url = `/${packageRequested.name}@${version}`;
      if (deep) url += `/${deep}`;
      url += stringify(query);

      res.redirect(302, url);
      return;
    }

    // If everything is good so far, then fetch the package and do the bundling part
    try {
      const zipped = await fetchBundle(packageRequested, tag, deep, query);

      if (!zipped) {
        console.error(`[${qualified}] Failed in fetching the bundle`);
        return res
          .status(500)
          .end(`Failed in fetching the bundle ${qualified}`);
      }

      console.info(`[${qualified}] serving ${zipped.length} bytes`);
      res.set(
        Object.assign(
          {
            "Content-Length": zipped.length,
            "Content-Type": "application/javascript; charset=utf-8",
            "Content-Encoding": "gzip",
          },
          additionalBundleResHeaders
        )
      );

      // FIXME(sven): calculate the etag based on the original content
      // ETag is used to manage the cache with the help of version number
      res.setHeader("ETag", etag(zipped));
      res.end(zipped);
    } catch (err) {
      console.error(`[${qualified}] ${err.message}`, err.stack);
      return res.status(500).end(`${err.message}`);
    }
  } catch (e) {
    console.error(`[${qualified}] Failed in fetching package from npm`);
    return res
      .status(400)
      .end(`Failed in fetching package from the npm ${qualified}`);
  }
};

const inProgress: Record<string, unknown> = {};

const fetchBundle = async (
  pkg: PackageJSON,
  version: PackageVersions,
  deep: string,
  query: ParsedUrlQueryInput
): Promise<Buffer> => {
  let hash = `${pkg.name}@${version}`;
  if (deep) hash += `_${deep.replace(/\//g, "_")}`;
  hash += stringify(query);

  console.info(`[${pkg.name}] requested package`);

  hash = sha1(hash);

  const bundleName = getBundleName(
    hash,
    (pkg.name as unknown) as string,
    version
  );

  const [result, file] = await cache.has(
    bundleName,
    (pkg.name as unknown) as string,
    version,
    "npm"
  );

  if (result) {
    console.info(`[${pkg.name}] is cached`);
    return Promise.resolve(cache.get(file));
  }

  if (inProgress[hash]) {
    console.info(`[${pkg.name}] request was already in progress`);
  } else {
    console.info(`[${pkg.name}] is not cached`);

    inProgress[hash] = createBundle(hash, pkg, version, deep, query)
      .then(
        (result: string) => {
          const zipped = zlib.gzipSync(result);
          cache.set(
            bundleName,
            result,
            (pkg.name as unknown) as string,
            version,
            "npm"
          );
          return zipped;
        },
        (err) => {
          inProgress[hash] = null;
          throw err;
        }
      )
      .then((zipped) => {
        inProgress[hash] = null;
        return zipped;
      });
  }

  return inProgress[hash] as Promise<Buffer>;
};
