"use strict";

const axios = require("axios");

function createPagSchoolApi({
  baseUrl,
  email,
  password,
  axiosInstance = axios,
} = {}) {
  let token = "";
  let tokenExp = 0;

  async function login() {
    if (!baseUrl || !email || !password) {
      throw new Error("PagSchool credentials are not configured.");
    }

    const now = Date.now();
    if (token && now < tokenExp) return token;

    const resp = await axiosInstance.post(
      `${baseUrl.replace(/\/$/, "")}/api/login`,
      { email, password },
      { timeout: 30000, validateStatus: () => true }
    );

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`PagSchool login error (${resp.status})`);
    }

    token = String(resp.data?.token || "");
    tokenExp = now + 1000 * 60 * 45;
    return token;
  }

  async function request({ method = "get", path, data, params }) {
    const bearer = await login();
    const resp = await axiosInstance.request({
      method,
      url: `${baseUrl.replace(/\/$/, "")}${path}`,
      data,
      params,
      timeout: 30000,
      validateStatus: () => true,
      headers: {
        Authorization: `Bearer ${bearer}`,
      },
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`PagSchool request error (${resp.status})`);
    }
    return resp.data;
  }

  return {
    login,
    request,
  };
}

module.exports = {
  createPagSchoolApi,
};

