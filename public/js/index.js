$( document ).ready( function() {
  $( '.create-button' ).addClass( 'disabled' ).attr( 'disabled', true );
  $( '.uname' ).blur( function( e ) {
    var unameVal = $( '.uname' ).val();
    if ( unameVal.length > 0 ) {
      $.ajax( {
        type: 'GET',
        url: '/api/user/' + $( '.uname' ).val()
      } ).done( function( found ) {
        if ( found === '1' ) {
          $( '#errorPlaceholder' ).html( 'Username already in use' );
          $( '.usernameGroup' ).addClass( 'has-error' ).removeClass( 'has-success' );
          $( '.create-button' ).addClass( 'disabled' ).attr( 'disabled', true );
        } else {
          $( '#errorPlaceholder' ).html( '' );
          $( '.usernameGroup' ).removeClass( 'has-error' ).addClass( 'has-success' );
          $( '.create-button' ).removeClass( 'disabled' ).attr( 'disabled', false );
        }
      } );
    } else {
      $( '.usernameGroup' ).removeClass( 'has-error' ).removeClass( 'has-success' );
    }
  } );

  $( '#password, #confirmPassword' ).keyup( function( e ) {
    var p = $( '#password' ).val(),
            cP = $( '#confirmPassword' ).val();
    if ( p !== cP ) {
      $( '.create-button' ).addClass( 'disabled' ).attr( 'disabled', true );
    } else if ( p === cP && p.length > 0 && cP.length > 0 ) {
      $( '.create-button' ).removeClass( 'disabled' ).attr( 'disabled', false );
    }
  } );
} );