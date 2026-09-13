const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json"); // 你的 Firebase 私鑰金鑰檔

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// 貼上剛剛在網頁/手機取得的 FCM Token
const registrationToken = "YOUR_COPIED_FCM_TOKEN";

const message = {
  data: {
    title: "測試推播標題",
    body: "這是一則測試推播訊息！"
  },
  token: registrationToken
};

admin.messaging().send(message)
  .then((response) => {
    console.log("推播發送成功：", response);
  })
  .catch((error) => {
    console.log("推播發送失敗：", error);
  });