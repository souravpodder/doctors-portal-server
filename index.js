const express = require('express');
const app = express();
const cors = require('cors');
const port = process.env.PORT || 5000;
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.37qjp.mongodb.net/myFirstDatabase?retryWrites=true&w=majority`;
console.log(uri);
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: 'Unauthorized Access' });
  }

  const token = authHeader.split(' ')[1];

  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, function (err, decoded) {
    if (err) {
      return res.status(403).send({ message: 'Forbidden Access' });
    }

    req.decoded = decoded;
    next();
  });
  // console.log('addf');
}

async function run() {
  try {
    await client.connect();
    console.log('database connedctedddd');
    const servicesCollection = client.db('Doctors_Portal_DB').collection('services');
    const bookingsCollection = client.db('Doctors_Portal_DB').collection('bookings');
    const usersCollection = client.db('Doctors_Portal_DB').collection('users');
    const doctorsCollection = client.db('Doctors_Portal_DB').collection('doctors');
    const paymentsCollection = client.db('Doctors_Portal_DB').collection('payments');

    const verifyAdmin = async (req, res, next) => {
      const requesterEmail = req.decoded.email;
      const requesterAccount = await usersCollection.findOne({ email: requesterEmail });

      if (requesterAccount.role === 'admin') {
        next();
      } else {
        res.status(403).send({ message: 'forbidden access' })
      }
    }

    app.get('/services', async (req, res) => {
      const query = {};
      const cursor = servicesCollection.find(query).project({ name: 1 });
      const result = await cursor.toArray();
      res.send(result);
    })

    // get all the users 
    app.get('/users', verifyJWT, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    })

    // get the booking of a individual person 
    app.get('/booking', verifyJWT, async (req, res) => {
      const email = req.query.email;

      const decodedEmail = req.decoded.email;
      if (email === decodedEmail) {
        const query = { patientEmail: email };
        const cursor = bookingsCollection.find(query);
        const bookings = await cursor.toArray();
        return res.send(bookings);
      } else {
        return res.status(403).send({ message: 'Forbidden Access' });
      }
    })

    // check if user is admin by get method 
    app.get('/admin/:email', async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email: email });
      const isAdmin = user.role === 'admin';
      res.send({ admin: isAdmin });
    })
    // get all the doctors info 
    app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
      const doctors = await doctorsCollection.find().toArray();
      res.send(doctors);
    })
    // post the doctor's info in database 
    app.post('/doctor', verifyJWT, verifyAdmin, async (req, res) => {
      const doctor = req.body;
      const result = await doctorsCollection.insertOne(doctor);
      res.send(result);
    })

    // delete a doctor 
    app.delete('/doctor/:email', async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const result = await doctorsCollection.deleteOne(query);
      res.send(result);
    })


    //update the user when sign in by google 
    app.put('/user/:email', async (req, res) => {
      const email = req.params.email;
      const user = req.body;
      const filter = { email: email };
      const options = { upsert: true };

      const updateDoc = {
        $set: user
      };
      const result = await usersCollection.updateOne(filter, updateDoc, options);
      const token = jwt.sign({ email: email }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
      res.send({ result, token });
    })

    // add a role as admin 
    app.put('/user/admin/:email', verifyJWT, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const filter = { email: email };

      const updateDoc = {
        $set: { role: 'admin' }
      };
      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);

    })

    // get the available services with slots 
    app.get('/available', async (req, res) => {
      const date = req.query.date;

      // get all the services 
      const services = await servicesCollection.find().toArray();

      // get the bookings of that day 
      const query = { bookingDate: date };
      const bookings = await bookingsCollection.find(query).toArray();

      //for each service find bookings of that service
      services.forEach(service => {
        const serviceBookingsOnThatDay = bookings.filter(booking => booking.treatment === service.name);
        const bookedSlots = serviceBookingsOnThatDay.map(servicebooking => servicebooking.slot);
        // service.booked = serviceBookingsOnThatDay.map(servicebooking => servicebooking.slot);
        const available = service.slots.filter(slot => !bookedSlots.includes(slot));
        // change the slots of services according to the available slots 
        service.slots = available;
      })
      res.send(services);
    })

    // insert the booking info 
    app.post('/booking', async (req, res) => {
      const newBooking = req.body;
      console.log(newBooking);
      const query = { treatment: newBooking.treatment, bookingDate: newBooking.bookingDate, patientEmail: newBooking.patientEmail };
      console.log(query);
      const exists = await bookingsCollection.findOne(query);
      // console.log(exists);

      if (exists) {
        return res.send({ success: false, booking: exists })
      }
      const result = await bookingsCollection.insertOne(newBooking);
      res.send({ success: true, result });
    })

    // payment works apis 
    //get the specific purchase infos
    app.get('/booking/:id', verifyJWT, async (req, res) => {
      const id = req.params.id;
      const query = { _id: ObjectId(id) };
      const booking = await bookingsCollection.findOne(query);
      res.send(booking);
    })

    // create payment api 
    app.post('/create-payment-intent', verifyJWT, async (req, res) => {
      const { price } = req.body;
      const amount = price * 100;

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: 'usd',
        payment_method_types: ['card']
      })

      res.send({
        clientSecret: paymentIntent.client_secret,
      })
    })

    app.patch('/booking/:id', async (req, res) => {
      const id = req.params.id;
      const payment = req.body;
      const filter = { _id: ObjectId(id) };

      const updatedDoc = {
        $set: {
          paid: true,
          transactionId: payment.transactionId
        }
      }

      const updatedBooking = await bookingsCollection.updateOne(filter, updatedDoc);
      const result = await paymentsCollection.insertOne(payment);
      res.send(result);
    })

  } finally {

  }
}

run().catch(console.dir);


app.get('/', (req, res) => {
  res.send('Doctors Server is running');
})

app.listen(port, () => {
  console.log('listening to port', port);
})