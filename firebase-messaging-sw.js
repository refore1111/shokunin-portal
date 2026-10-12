// プッシュ通知の受け口（GENPUKU Pro 協力業者ポータル）
// index.html と同じ場所に置いてください。通知の表示と、押したときにポータルを開く処理だけをします。
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyA7V4lfZQrxV2LZTnW6UbAB-CTmmeAISGE",
  authDomain: "shokunin-portal.firebaseapp.com",
  projectId: "shokunin-portal",
  storageBucket: "shokunin-portal.firebasestorage.app",
  messagingSenderId: "871865092461",
  appId: "1:871865092461:web:f79a18646f7ac36f1af264"
});
firebase.messaging();
// 通知の表示と、押したときにポータルの該当ページを開く処理は Firebase が行います（送る側で link を指定）
