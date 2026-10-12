// Must be the FIRST import of the main entry: every other module derives userData/keychain
// paths from app.name at import time. The display name is "YouTube Quran Uploader" (productName);
// the internal name stays "Yoosy Joosy" so existing users keep their settings and Google token.
import { app } from 'electron'
app.setName('Yoosy Joosy')
