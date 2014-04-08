var socket = io.connect( window.location.hostname );

$( document ).on( 'ready', function() {
  $( '.chat-widget' ).hide();
  $( '#join-chat' ).click( function() {
    $( '#join-chat' ).hide();
    $( '.chat-widget' ).show();
    socket.emit( 'joined', { } );
  } );
  $( "#chatMessage" ).keydown( function( e ) {
    var code = e.which;
    if ( code == 13 ) {
      e.preventDefault();
      socket.emit( 'clientchat', {
        message: $( '#chatMessage' ).val()
      } );
      $( '#chatMessage' ).val( '' );
    }
  } );
  $( '#send-chat' ).click( function( e ) {
    socket.emit( 'clientchat', {
      message: $( '#chatMessage' ).val()
    } );
    $( '#chatMessage' ).val( '' );
  } );
  socket.on( 'chat', function( data ) {
    $( '#textarea' ).append( data.message ).animate( {
      scrollTop: $( "#textarea" )[0].scrollHeight - $( "#textarea" ).height()
    },
    250 );
    if ( data.username ) {
      $( '#users' ).append( '<span class="label label-success" id="username-' + data.username + '"">' + data.username + '</span>' );
    }
    if ( data.users ) {
      var userHtml = '';
      for ( var i = 0; i < data.users.length; i++ ) {
        userHtml += '<span class="label label-success" id="username-' + data.users[i] + '"">' + data.users[i] + '</span>';
      }
      $( '#users' ).html( userHtml );
    }
  } );
  socket.on( 'disconnect', function( data ) {
    $( '#username-' + data.username ).remove();
  } );
} );
