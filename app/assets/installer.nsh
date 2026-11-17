; Удаление Контроля звонков: спрашиваем, удалить ли скачанные модели, архив звонков и настройки.
; Отчёты в «Документы\Контроль звонков» не трогаем никогда.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Удалить скачанные модели, архив разобранных звонков и настройки Контроля звонков?$\r$\n$\r$\nОтчёты в папке «Документы\Контроль звонков» и сами записи останутся." /SD IDNO IDNO skipModels
      RMDir /r "$LOCALAPPDATA\KontrolZvonkov"
      ReadEnvStr $0 "ProgramData"
      RMDir /r "$0\KontrolZvonkov"
    skipModels:
  ${endIf}
!macroend
