const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aylyes", {
  getSavedToken: () => ipcRenderer.invoke("get-saved-token"),
  login: (username, password) => ipcRenderer.invoke("login", { username, password }),
  verifyOtp: (username, otp) => ipcRenderer.invoke("verify-otp", { username, otp }),
  logout: (token) => ipcRenderer.invoke("logout", { token }),
  getMe: (token) => ipcRenderer.invoke("get-me", { token }),
  getCountries: (token) => ipcRenderer.invoke("get-countries", { token }),
  connect: (token, country) => ipcRenderer.invoke("connect", { token, country }),
  disconnect: () => ipcRenderer.invoke("disconnect"),
  isConnected: () => ipcRenderer.invoke("is-connected"),
});
