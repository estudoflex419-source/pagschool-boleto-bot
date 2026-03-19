""use strict";

const axios = require("axios");

function createPagSchoolApi({
  baseUrl,
  email,
  password,
  axiosInstance = axios,
} = {}) {
  let token = "";
  let tokenExp = 0;
  let preferredAuthScheme = "";

  function clean(value) {
    return String(value || "").trim();
  }

  function cleanBaseUrl(url) {
    return clean(url).replace(/\/$/, "");
  }

  function dedupeStrings(items = []) {
    return [...new Set(items.filter(Boolean))];
  }

  function buildUrls(docPath) {
    const base = cleanBaseUrl(baseUrl);
    const path = `/${String(docPath || "").replace(/^\/+/, "")}`;

    const pathWithoutApi = path.replace(/^\/api\b/, "") || "/";
    const isBaseApi = /\/api$/i.test(base);

    if (isBaseApi) {
      return dedupeStrings([
        `${base}${pathWithoutApi}`,
        `${base}${path}`,
      ]);
    }

    return dedupeStrings([
      `${base}${path}`,
      `${base}/api${pathWithoutApi}`,
    ]);
  }

  function extractToken(payload) {
    return (
      payload?.token ||
      payload?.jwt ||
      payload?.accessToken ||
      payload?.data?.token ||
      payload?.data?.jwt ||
      payload?.data?.accessToken ||
      ""
    );
  }

  async function rawRequest({
    method = "get",
    docPath,
    params,
    data,
    responseType = "json",
    headers = {},
  }) {
    if (!baseUrl) {
      throw new Error("PagSchool baseUrl is not configured.");
    }

    const urls = buildUrls(docPath);
    const errors = [];

    for (const url of urls) {
      try {
        const resp = await axiosInstance({
          method,
          url,
          params,
          data,
          responseType,
          timeout: 30000,
          validateStatus: () => true,
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
        });

        if (resp.status >= 200 && resp.status < 300) {
          return { ...resp, triedUrl: url };
        }

        errors.push({
          url,
          status: resp.status,
          data: resp.data,
        });
      } catch (error) {
        errors.push({
          url,
          status: 0,
          data: String(error.message || error),
        });
      }
    }

    throw new Error(
      `PagSchool raw request failed for ${docPath}: ${JSON.stringify(errors)}`
    );
  }

  async function login(forceRefresh = false) {
    if (!clean(baseUrl) || !clean(email) || !clean(password)) {
      throw new Error("PagSchool credentials are not configured.");
    }

    const now = Date.now();
    if (!forceRefresh && token && now < tokenExp) {
      return token;
    }

    const attempts = [
      { docPath: "/api/authenticate", data: { email, password } },
      { docPath: "/authenticate", data: { email, password } },
      { docPath: "/api/login", data: { email, password } },
      { docPath: "/login", data: { email, password } },
    ];

    const errors = [];

    for (const attempt of attempts) {
      try {
        const resp = await rawRequest({
          method: "post",
          docPath: attempt.docPath,
          data: attempt.data,
          responseType: "json",
        });

        const foundToken = String(extractToken(resp.data) || "").trim();

        if (foundToken) {
          token = foundToken;
          tokenExp = Date.now() + 1000 * 60 * 45;

          const tokenType =
            String(
              resp?.data?.tokenType ||
              resp?.data?.type ||
              resp?.data?.authType ||
              resp?.data?.data?.tokenType ||
              ""
            ).trim();

          if (/^bearer$/i.test(tokenType)) {
            preferredAuthScheme = "Bearer";
          } else if (/^jwt$/i.test(tokenType)) {
            preferredAuthScheme = "JWT";
          } else {
            preferredAuthScheme = "";
          }

          return token;
        }

        errors.push({
          docPath: attempt.docPath,
          triedUrl: resp.triedUrl,
          data: resp.data,
        });
      } catch (error) {
        errors.push({
          docPath: attempt.docPath,
          error: String(error.message || error),
        });
      }
    }

    throw new Error(
      `PagSchool login failed: ${JSON.stringify(errors)}`
    );
  }

  async function request(
    { method = "get", path, data, params, responseType = "json" },
    retry = true
  ) {
    const currentToken = await login(false);
    const urls = buildUrls(path);

    const authHeaders = dedupeStrings([
      preferredAuthScheme ? `${preferredAuthScheme} ${currentToken}` : "",
      `JWT ${currentToken}`,
      `Bearer ${currentToken}`,
    ]);

    const errors = [];

    for (const url of urls) {
      for (const authHeader of authHeaders) {
        try {
          const resp = await axiosInstance({
            method,
            url,
            data,
            params,
            responseType,
            timeout: 30000,
            validateStatus: () => true,
            headers: {
              "Content-Type": "application/json",
              Authorization: authHeader,
            },
          });

          if (resp.status === 401 && retry) {
            await login(true);
            return request({ method, path, data, params, responseType }, false);
          }

          if (resp.status >= 200 && resp.status < 300) {
            return { ...resp, triedUrl: url };
          }

          errors.push({
            url,
            auth: authHeader.startsWith("JWT ") ? "JWT" : "Bearer",
            status: resp.status,
            data: resp.data,
          });
        } catch (error) {
          errors.push({
            url,
            auth: authHeader.startsWith("JWT ") ? "JWT" : "Bearer",
            status: 0,
            data: String(error.message || error),
          });
        }
      }
    }

    throw new Error(
      `PagSchool request failed for ${path}: ${JSON.stringify(errors)}`
    );
  }

  async function requestData(options, retry = true) {
    const resp = await request(options, retry);
    return resp.data;
  }

  async function requestBuffer({ method = "get", path, data, params }, retry = true) {
    return request(
      {
        method,
        path,
        data,
        params,
        responseType: "arraybuffer",
      },
      retry
    );
  }

  return {
    login,
    request,
    requestData,
    requestBuffer,
    buildUrls,
  };
}

module.exports = {
  createPagSchoolApi,
};
